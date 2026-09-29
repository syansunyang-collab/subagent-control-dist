import { createSessionBoundControl } from "../../adapters/pi/src/session-bound-control.mjs";

export default function controlDelegateProjectExtension(pi, options) {
  return createSessionBoundControl(pi, {
    allow_any_project: true,
    skip_when_project_extension_exists: false,
  }, options);
}
