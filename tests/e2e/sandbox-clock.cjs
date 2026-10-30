"use strict";

const realNow = Date.now.bind(Date);
const floorMs = Number(process.env.PXE_BRIDGE_TEST_CLOCK_FLOOR_MS);
if (!Number.isSafeInteger(floorMs) || floorMs <= 0) {
  throw new Error("PXE_BRIDGE_TEST_CLOCK_FLOOR_MS must be a positive safe integer");
}
const offsetMs = Math.max(0, floorMs - realNow());
Date.now = () => realNow() + offsetMs;
