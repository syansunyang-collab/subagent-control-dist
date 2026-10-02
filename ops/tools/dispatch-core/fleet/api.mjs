// Late bindings for fleet modules that would otherwise import each other.
// Each module assigns its own functions during init; callers read them at call time.
export const api = {};
