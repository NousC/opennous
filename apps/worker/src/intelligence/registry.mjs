// The registries. A behavior or an observation becomes part of the engine by being
// registered here — that is the whole extension model. Phase 0 ships them empty;
// Phase 1 registers the first extractor + job. The runners iterate these, so an
// empty registry means the engine runs idle (no work, no cost).

const extractors = new Map();  // key -> BehaviorExtractor
const jobs = new Map();        // key -> LearningJob

export function registerExtractor(extractor) {
  if (!extractor?.key || typeof extractor.extract !== 'function') {
    throw new Error('registerExtractor: need { key, extract() }');
  }
  extractors.set(extractor.key, extractor);
}

export function registerJob(job) {
  if (!job?.key || typeof job.learn !== 'function') {
    throw new Error('registerJob: need { key, learn() }');
  }
  jobs.set(job.key, job);
}

export function getExtractors() {
  return [...extractors.values()];
}

export function getJobs(cadence) {
  const all = [...jobs.values()];
  return cadence ? all.filter((j) => j.cadence === cadence) : all;
}
