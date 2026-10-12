// Pin the preview API's clock (GET-596). The fixture world dates everything from "now"
// ("closes in 12 days", "quiet for 17 days"), so without a fixed now the visual baselines
// would change every day. Loaded with `node --import ./preview/fixed-clock.mjs` only when
// PREVIEW_NOW is set (an ISO instant); otherwise it does nothing.
const pinned = process.env.PREVIEW_NOW ? Date.parse(process.env.PREVIEW_NOW) : NaN;

if (!Number.isNaN(pinned)) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(pinned);
      else super(...args);
    }
    static now() {
      return pinned;
    }
  }
  globalThis.Date = FixedDate;
}
