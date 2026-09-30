// `node --import` entry: registers the extensionless-`.ts` resolve hook.
// Run the harness as: node --import ./register.mjs run.ts  (from this dir).
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
