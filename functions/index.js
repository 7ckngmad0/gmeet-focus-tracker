import { initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const RETENTION_DAYS = 30;
const BATCH_SIZE = 400;
const MAX_DELETES_PER_COLLECTION = 4000;
const MAX_SCANNED_PER_COLLECTION = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function deleteSubcollectionDocuments(documentRef, collectionName, maxDeletes) {
  let deleted = 0;
  while (deleted < maxDeletes) {
    const limit = Math.min(BATCH_SIZE, maxDeletes - deleted);
    const snapshot = await documentRef.collection(collectionName).limit(limit).get();
    if (snapshot.empty) return { deleted, complete: true };
    const batch = getFirestore().batch();
    snapshot.docs.forEach(document => batch.delete(document.ref));
    await batch.commit();
    deleted += snapshot.size;
    if (snapshot.size < limit) return { deleted, complete: true };
  }
  const remaining = await documentRef.collection(collectionName).limit(1).get();
  return { deleted, complete: remaining.empty };
}

async function deleteExpiredDocuments(collectionName, timestampField, cutoff, keepDocument, beforeDelete) {
  const db = getFirestore();
  let deleted = 0;
  let scanned = 0;
  let cursor = null;
  let reachedCleanupLimit = false;

  while (deleted < MAX_DELETES_PER_COLLECTION && scanned < MAX_SCANNED_PER_COLLECTION) {
    const limit = Math.min(BATCH_SIZE, MAX_SCANNED_PER_COLLECTION - scanned);
    let query = db.collection(collectionName)
      .where(timestampField, "<", cutoff)
      .orderBy(timestampField, "asc")
      .limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();

    if (snapshot.empty) break;
    cursor = snapshot.docs.at(-1);
    scanned += snapshot.size;
    const batch = db.batch();
    let batchDeletes = 0;
    let stop = false;
    for (const document of snapshot.docs) {
      if (keepDocument && !keepDocument(document.data())) continue;
      if (beforeDelete && !(await beforeDelete(document.ref))) {
        reachedCleanupLimit = true;
        stop = true;
        break;
      }
      batch.delete(document.ref);
      batchDeletes += 1;
    }
    if (batchDeletes) await batch.commit();
    deleted += batchDeletes;
    if (stop) break;
    if (snapshot.size < limit) break;
  }

  return { deleted, scanned, hitLimit: reachedCleanupLimit || deleted >= MAX_DELETES_PER_COLLECTION || scanned >= MAX_SCANNED_PER_COLLECTION };
}

export const pruneExpiredActivity = onSchedule({
  schedule: "every day 02:30",
  timeZone: "Asia/Manila",
  region: "asia-southeast1",
  maxInstances: 1,
  timeoutSeconds: 540,
}, async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * DAY_MS);
  const db = getFirestore();
  const openSessions = await Promise.all(["active", "paused"].map(status =>
    db.collection("sessions").where("status", "==", status).get(),
  ));
  const openSessionIds = new Set(openSessions.flatMap(snapshot => snapshot.docs.map(document => document.id)));

  // Use server receipt time for activity, not the student's device clock.
  const eventResult = await deleteExpiredDocuments(
    "events",
    "receivedAt",
    cutoff,
    data => !openSessionIds.has(data.sessionId),
  );
  // endedAt is written by the professor action. Old active or paused sessions
  // have no endedAt and therefore remain untouched.
  const sessionResult = await deleteExpiredDocuments(
    "sessions",
    "endedAt",
    cutoff,
    data => data.status === "ended",
  );
  const afkResult = await deleteExpiredDocuments("afkRequests", "createdAt", cutoff);
  const alertResult = await deleteExpiredDocuments("professorAlerts", "createdAt", cutoff);
  let deletedActivityResponses = 0;
  let activityResponseLimitReached = false;
  const activityResult = await deleteExpiredDocuments(
    "classActivities",
    "createdAt",
    cutoff,
    data => openSessionIds.has(data.sessionId),
    async document => {
      const remainingDeletes = MAX_DELETES_PER_COLLECTION - deletedActivityResponses;
      const result = await deleteSubcollectionDocuments(document, "responses", remainingDeletes);
      deletedActivityResponses += result.deleted;
      if (!result.complete) activityResponseLimitReached = true;
      return result.complete;
    },
  );

  logger.info("Expired class data pruned", {
    retentionDays: RETENTION_DAYS,
    deletedEvents: eventResult.deleted,
    scannedEvents: eventResult.scanned,
    deletedSessions: sessionResult.deleted,
    scannedSessions: sessionResult.scanned,
    deletedAfkRequests: afkResult.deleted,
    deletedProfessorAlerts: alertResult.deleted,
    deletedClassActivities: activityResult.deleted,
    scannedClassActivities: activityResult.scanned,
    deletedClassActivityResponses: deletedActivityResponses,
    cutoff: cutoff.toDate().toISOString(),
    hitDeletionLimit: eventResult.hitLimit || sessionResult.hitLimit || afkResult.hitLimit || alertResult.hitLimit || activityResult.hitLimit || activityResponseLimitReached,
  });
});
