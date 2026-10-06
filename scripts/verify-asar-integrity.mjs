import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getRawHeader } from "@electron/asar";
/** Verify the physical archive bytes, including unpacked native files, after packing finishes. */
export function verifyAsarIntegrity(archive) {
  const { header, headerSize } = getRawHeader(archive);
  const bytes = readFileSync(archive);
  let checked = 0;
  const visit = (files, prefix = "") => {
    for (const [name, entry] of Object.entries(files)) {
      const filename = prefix + name;
      if (entry.files) {
        visit(entry.files, filename + "/");
        continue;
      }
      if (entry.link) continue;
      if (!entry.integrity?.hash) throw new Error(`Missing packaged integrity: ${filename}`);
      const body = entry.unpacked
        ? readFileSync(`${archive}.unpacked/${filename}`)
        : bytes.subarray(headerSize + 8 + Number(entry.offset), headerSize + 8 + Number(entry.offset) + entry.size);
      if (body.length !== entry.size || createHash("sha256").update(body).digest("hex") !== entry.integrity.hash)
        throw new Error(`Packaged integrity mismatch: ${filename}`);
      checked++;
    }
  };
  visit(header.files);
  return checked;
}
