import { initializeApp } from "firebase-admin/app"
import { defineString, defineSecret } from "firebase-functions/params"
import { getStorage } from "firebase-admin/storage"

initializeApp()

export const env = defineString("NODE_ENV", { default: "development" })
export const minInstances = env.equals("production").thenElse(1, 0)
export const rawBucket = getStorage().bucket()
export const cloudflareApiToken = defineSecret("CLOUDFLAR_API_TOKEN")
export const cloudflareAccountId = defineSecret("CLOUDFLAR_ACCOUNT_ID")
export const cloudflareBaseURL = defineString("CLOUDFLAR_BASE_URL")

export * from "./imageService"
export * from "./videoService"
