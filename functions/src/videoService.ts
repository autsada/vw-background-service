import video from "@google-cloud/video-intelligence"
import { logger } from "firebase-functions"
import { onObjectFinalized } from "firebase-functions/v2/storage"
import * as path from "path"
import axios from "axios"
import { promisify } from "util"
import * as fs from "fs"
import * as os from "os"
import { mkdirp } from "mkdirp"

import {
  minInstances,
  rawBucket,
  cloudflareApiToken,
  cloudflareAccountId,
  cloudflareBaseURL,
} from "."

// Human-readable likelihoods
const likelihoods = [
  "UNKNOWN",
  "VERY_UNLIKELY",
  "UNLIKELY",
  "POSSIBLE",
  "LIKELY",
  "VERY_LIKELY",
]
const REPLACEMENT_VIDEO_FILE_PATH = "annotate.mp4"

// A background triggered function to transcode videos.
export const transcodeVideo = onObjectFinalized(
  {
    minInstances,
    maxInstances: 100,
    secrets: [cloudflareAccountId, cloudflareApiToken],
    timeoutSeconds: 300,
    memory: "2GiB",
    concurrency: 100,
  },
  async (evt) => {
    try {
      // File path will be in the form of `publishes/{station_name}/{publishId}/{filename}.mp4` and this is unique.
      const filePath = evt.data.name

      if (!filePath) {
        logger.log("Object not found")
        return null
      }

      const contentType = evt.data.contentType
      if (!contentType?.startsWith("video/")) {
        logger.log("Only transcode videos")
        return null
      }

      const isAdult = await videoSafeSearchDetection(
        `gs://${evt.bucket}/${filePath}`
      )

      if (isAdult) {
        logger.log("Adult or violent content detected")
        // Delete the video.
        await rawBucket.file(filePath).delete()

        // Replace the deleted video with the video that shows prohibited sign
        // Construct temp file path to save the replacement video to
        const tempFilePath = path.join(os.tmpdir(), filePath)
        // Get the temp dir name from the file path
        const tempFileDir = path.dirname(tempFilePath)
        // Create the temp dir where the replacement video will be downloaded to.
        await mkdirp(tempFileDir)
        // Download the replacement video to the temp dir
        const replacementFile = rawBucket.file(REPLACEMENT_VIDEO_FILE_PATH)
        await replacementFile.download({ destination: tempFilePath })
        logger.log(
          "The replacement file has been downloaded to: ",
          tempFilePath
        )
        // Upload the replacment video back to the deleted file path
        await rawBucket.upload(tempFilePath, {
          destination: filePath,
          resumable: true,
        })
        logger.log("Uploaded the replacement file to: ", filePath)

        // Unlink the downloaded replacement file to free up space
        const unlink = promisify(fs.unlink)
        await unlink(tempFilePath)
        logger.log("Unlinked the downloaded file from: ", tempFilePath)
      } else {
        // Call Cloudflare Stream API to transcode the video
        const baseName = path.basename(filePath, path.extname(filePath))
        const extName = path.extname(filePath)
        const fileName = path.format({ name: baseName, ext: extName })
        // Get a download signed url.
        const uploadedFile = rawBucket.file(filePath)
        const signedURLs = await uploadedFile.getSignedUrl({
          action: "read",
          expires: Date.now() + 1000 * 60 * 60, // 1 hour from now
        })
        const downloadURL = signedURLs[0]
        const cloudflareBaseURLValue = cloudflareBaseURL.value()
        const cloudflareAccountIdValue = cloudflareAccountId.value()
        const cloudflareApiTokenValue = cloudflareApiToken.value()
        await axios({
          method: "POST",
          url: `${cloudflareBaseURLValue}/${cloudflareAccountIdValue}/stream/copy`,
          headers: {
            Authorization: `Bearer ${cloudflareApiTokenValue}`,
            "Content-Type": "application/json",
          },
          data: {
            url: downloadURL,
            meta: {
              name: fileName,
              path: filePath,
              contentURI: downloadURL,
              contentRef: filePath,
            },
          },
        })
      }

      logger.log("Processing video finished")
      return null
    } catch (error) {
      logger.error(error)
      throw error
    }
  }
)

// Detect adult content
async function videoSafeSearchDetection(gcsUri: string) {
  // Creates a client
  const client = new video.VideoIntelligenceServiceClient()

  // Detects unsafe content
  const [operation] = await client.annotateVideo({
    inputUri: gcsUri,
    features: ["EXPLICIT_CONTENT_DETECTION"] as any,
  })
  const [operationResult] = await operation.promise()
  // Gets unsafe content
  const explicitContentResults = operationResult.annotationResults

  let isAdult: boolean = false

  if (!explicitContentResults) return isAdult

  const results = explicitContentResults[0].explicitAnnotation

  if (results?.frames && results.frames.length > 0) {
    results.frames.forEach((frame) => {
      isAdult =
        (!!frame.pornographyLikelihood &&
          likelihoods[frame.pornographyLikelihood as number] === "POSSIBLE") ||
        (!!frame.pornographyLikelihood &&
          likelihoods[frame.pornographyLikelihood as number] === "LIKELY") ||
        (!!frame.pornographyLikelihood &&
          likelihoods[frame.pornographyLikelihood as number] === "VERY_LIKELY")
    })
  }

  return isAdult
}
