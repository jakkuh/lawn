import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "requeue stale transcode jobs",
  { seconds: 30 },
  internal.transcodeQueue.requeueStaleJobs,
);

export default crons;
