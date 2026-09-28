export let activeAttempt;
export let activeDependencyCollector;

export function createRenderAttempt() {
  const attempt = {
    dependencies: new Map(),
    add(readable, version) {
      if (!this.dependencies.has(readable)) this.dependencies.set(readable, version);
    },
  };
  return attempt;
}

export function setRenderCollector(collector) {
  const previous = activeDependencyCollector;
  activeDependencyCollector = collector;
  activeAttempt = collector;
  return previous;
}
export function pushRenderCollector(collector) {
  const previousAttempt = activeAttempt;
  const previousCollector = activeDependencyCollector;
  activeAttempt = collector;
  activeDependencyCollector = collector;
  return () => {
    activeAttempt = previousAttempt;
    activeDependencyCollector = previousCollector;
  };
}
export function getRenderAttempt() { return activeAttempt; }
export function getRenderCollector() { return activeDependencyCollector; }
export function trackReadable(readable, version) {
  activeDependencyCollector?.add(readable, version);
}
export function withRenderDependencyCollector(collector, callback) {
  const previous = activeDependencyCollector;
  activeDependencyCollector = collector;
  try { return callback(); }
  finally { activeDependencyCollector = previous; }
}
export function withoutRenderCollection(callback) {
  const previous = activeDependencyCollector;
  activeDependencyCollector = undefined;
  try { return callback(); }
  finally { activeDependencyCollector = previous; }
}
export function withoutRenderAttempt(callback) {
  const previousAttempt = activeAttempt;
  const previousCollector = activeDependencyCollector;
  activeAttempt = undefined;
  activeDependencyCollector = undefined;
  try { return callback(); }
  finally {
    activeAttempt = previousAttempt;
    activeDependencyCollector = previousCollector;
  }
}
export function withNewRenderAttempt(callback) {
  const previousAttempt = activeAttempt;
  const previousCollector = activeDependencyCollector;
  const attempt = createRenderAttempt();
  activeAttempt = attempt;
  activeDependencyCollector = attempt;
  try { return callback(); }
  finally {
    activeAttempt = previousAttempt;
    activeDependencyCollector = previousCollector;
  }
}

export function withRenderAttempt(attempt, callback) {
  const previousAttempt = activeAttempt;
  const previousCollector = activeDependencyCollector;
  activeAttempt = attempt;
  activeDependencyCollector = attempt;
  try { return callback(); }
  finally {
    activeAttempt = previousAttempt;
    activeDependencyCollector = previousCollector;
  }
}
