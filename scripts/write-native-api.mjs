/* Writes the generated API client. See gen-native-api.mjs, which is
   deliberately free of side effects so the contract test can import it
   without repairing the file it is about to check. */
import fs from "node:fs";
import path from "node:path";
import { generate, OUT } from "./gen-native-api.mjs";

const { text, count } = generate();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`AurionApi.g.cs: ${count} methods`);
