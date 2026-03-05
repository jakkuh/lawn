import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type Stripe from "stripe";
import { components, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

function getSubscriptionPriceId(subscription: Stripe.Subscription): string | undefined {
  return subscription.items.data[0]?.price?.id;
}

function getSubscriptionOrgId(subscription: Stripe.Subscription): string | undefined {
  const orgId = subscription.metadata.orgId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}

registerRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
  events: {
    "customer.subscription.created": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.created" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
    "customer.subscription.updated": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.updated" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
    "customer.subscription.deleted": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.deleted" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
  },
});

http.route({
  path: "/webhooks/mux",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const signature = request.headers.get("mux-signature") ?? undefined;

    try {
      const result = await ctx.runAction(internal.muxActions.processWebhook, {
        rawBody,
        signature,
      });

      return new Response(result.message, { status: result.status });
    } catch (error) {
      console.error("Mux webhook proxy failed", error);
      return new Response("Webhook processing failed", { status: 500 });
    }
  }),
});

// ---------------------------------------------------------------------------
// Transcode queue API (pull-based — transcoder polls these endpoints)
// ---------------------------------------------------------------------------

function verifyTranscoderSecret(request: Request): boolean {
  const secret = process.env.TRANSCODER_WEBHOOK_SECRET || "";
  if (!secret) return true;
  return (request.headers.get("x-transcoder-secret") || "") === secret;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

http.route({
  path: "/api/transcode/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyTranscoderSecret(request))
      return jsonResponse(401, { error: "unauthorized" });

    const body = (await request.json()) as Record<string, unknown>;
    const workerId = body.workerId as string | undefined;
    if (!workerId) return jsonResponse(400, { error: "workerId required" });

    const job = await ctx.runMutation(internal.transcodeQueue.claimNext, {
      workerId,
    });
    return jsonResponse(200, { job });
  }),
});

http.route({
  path: "/api/transcode/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyTranscoderSecret(request))
      return jsonResponse(401, { error: "unauthorized" });

    const body = (await request.json()) as Record<string, unknown>;
    const jobId = body.jobId as string | undefined;
    const workerId = body.workerId as string | undefined;
    if (!jobId || !workerId)
      return jsonResponse(400, { error: "jobId and workerId required" });

    type TierStatus = "pending" | "processing" | "completed" | "failed";
    const rawTiers = body.tiers as
      | Array<{ tag: string; status: string; error?: string }>
      | undefined;
    const tiers = rawTiers?.map((t) => ({
      tag: t.tag,
      status: t.status as TierStatus,
      error: t.error,
    }));

    await ctx.runMutation(internal.transcodeQueue.heartbeat, {
      jobId: jobId as Id<"transcodeJobs">,
      workerId,
      tiers,
      sourceWidth:
        typeof body.sourceWidth === "number" ? body.sourceWidth : undefined,
      sourceHeight:
        typeof body.sourceHeight === "number" ? body.sourceHeight : undefined,
      sourceDuration:
        typeof body.sourceDuration === "number"
          ? body.sourceDuration
          : undefined,
    });

    return jsonResponse(200, { ok: true });
  }),
});

http.route({
  path: "/api/transcode/tier-update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyTranscoderSecret(request))
      return jsonResponse(401, { error: "unauthorized" });

    const body = (await request.json()) as Record<string, unknown>;
    const jobId = body.jobId as string | undefined;
    const tier = body.tier as string | undefined;
    const status = body.status as string | undefined;
    if (!jobId || !tier || !status)
      return jsonResponse(400, { error: "jobId, tier, status required" });

    await ctx.runMutation(internal.transcodeQueue.updateTier, {
      jobId: jobId as Id<"transcodeJobs">,
      tier,
      status: status as "pending" | "processing" | "completed" | "failed",
      error: typeof body.error === "string" ? body.error : undefined,
    });

    return jsonResponse(200, { ok: true });
  }),
});

http.route({
  path: "/api/transcode/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyTranscoderSecret(request))
      return jsonResponse(401, { error: "unauthorized" });

    const body = (await request.json()) as Record<string, unknown>;
    const jobId = body.jobId as string | undefined;
    const hlsKey = body.hlsKey as string | undefined;
    if (!jobId || !hlsKey)
      return jsonResponse(400, { error: "jobId, hlsKey required" });

    await ctx.runMutation(internal.transcodeQueue.completeJob, {
      jobId: jobId as Id<"transcodeJobs">,
      hlsKey,
      thumbnailKey:
        typeof body.thumbnailKey === "string" ? body.thumbnailKey : undefined,
      duration:
        typeof body.duration === "number" ? body.duration : undefined,
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
    });

    return jsonResponse(200, { ok: true });
  }),
});

http.route({
  path: "/api/transcode/fail",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyTranscoderSecret(request))
      return jsonResponse(401, { error: "unauthorized" });

    const body = (await request.json()) as Record<string, unknown>;
    const jobId = body.jobId as string | undefined;
    const error = body.error as string | undefined;
    if (!jobId || !error)
      return jsonResponse(400, { error: "jobId, error required" });

    await ctx.runMutation(internal.transcodeQueue.failJob, {
      jobId: jobId as Id<"transcodeJobs">,
      error,
    });

    return jsonResponse(200, { ok: true });
  }),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("OK", { status: 200 });
  }),
});

export default http;
