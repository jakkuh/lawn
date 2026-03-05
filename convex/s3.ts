import { S3Client } from "@aws-sdk/client-s3";

export const BUCKET_NAME = process.env.RAILWAY_BUCKET_NAME || "videos";

function getBasePublicUrl(): string {
  const baseUrl = process.env.RAILWAY_PUBLIC_URL || process.env.RAILWAY_ENDPOINT;
  if (!baseUrl) {
    throw new Error("Missing RAILWAY_PUBLIC_URL or RAILWAY_ENDPOINT for bucket URLs");
  }
  return baseUrl;
}

export function buildPublicUrl(key: string): string {
  const includeBucket = process.env.RAILWAY_PUBLIC_URL_INCLUDE_BUCKET !== "false";
  const url = new URL(getBasePublicUrl());
  const basePath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  const objectPath = includeBucket ? `${BUCKET_NAME}/${key}` : key;
  url.pathname = `${basePath}/${objectPath}`;
  return url.toString();
}

export function buildPublicContentUrl(key: string): string {
  const r2PublicUrl = process.env.R2_PUBLIC_URL;
  if (r2PublicUrl) {
    const base = r2PublicUrl.endsWith("/") ? r2PublicUrl.slice(0, -1) : r2PublicUrl;
    return `${base}/${key}`;
  }
  return buildPublicUrl(key);
}

function getS3Credentials() {
  const accessKeyId = process.env.RAILWAY_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RAILWAY_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing Railway S3 credentials");
  }

  return { accessKeyId, secretAccessKey };
}

export function getS3Client(): S3Client {
  const credentials = getS3Credentials();

  return new S3Client({
    region: process.env.RAILWAY_REGION || "us-east-1",
    endpoint: process.env.RAILWAY_ENDPOINT,
    credentials,
    forcePathStyle: true,
  });
}

export function getS3SigningClient(): S3Client {
  const publicUrl = process.env.RAILWAY_PUBLIC_URL;
  if (!publicUrl) {
    return getS3Client();
  }

  const credentials = getS3Credentials();

  return new S3Client({
    region: process.env.RAILWAY_REGION || "us-east-1",
    endpoint: publicUrl,
    credentials,
    forcePathStyle: true,
  });
}
