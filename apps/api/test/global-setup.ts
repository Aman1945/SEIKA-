import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * One in-memory MongoDB **replica set** for the whole run. A replica set (not a
 * standalone) is mandatory: every money path in SEIKA commits inside a
 * multi-document transaction, and transactions require one. Testing the money
 * paths against a standalone mongod would silently skip the thing most worth
 * testing.
 */
let replSet: MongoMemoryReplSet;

export async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.SEIKA_TEST_MONGO_URI = replSet.getUri("seika_test");
}

export async function teardown() {
  await replSet?.stop();
}
