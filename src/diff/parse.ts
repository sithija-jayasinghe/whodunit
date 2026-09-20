import type { FilePatch, Hunk } from "../types.js";

const FILE_START = "diff --git ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_PAYLOAD = "GIT binary patch";
const BINARY_NOTICE = "Binary files ";

/**
 * Undo Git's C-style quoting of paths containing unusual bytes.
 * Git only quotes when it has to, so the common path is the early return.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      out += inner[i];
      continue;
    }
    const next = inner[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      default: {
        // Octal escape: \NNN
        if (next !== undefined && next >= "0" && next <= "7") {
          const octal = inner.slice(i, i + 3);
          out += String.fromCharCode(parseInt(octal, 8));
          i += 2;
        } else if (next !== undefined) {
          out += next;
        }
      }
    }
  }
  return out;
}

/** Strip the a/ or b/ prefix Git puts on diff paths. */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/**
 * Work out the path a file patch refers to.
 *
 * The +++ and --- lines are the reliable source because Git terminates them at
 * a tab, so paths containing spaces survive. The "diff --git a/x b/x" line is
 * ambiguous for such paths, so it is only the fallback.
 */
function resolveFile(headerLines: readonly string[]): string {
  let fromNew: string | undefined;
  let fromOld: string | undefined;

  for (const line of headerLines) {
    if (line.startsWith("+++ ")) {
      fromNew = stripPrefix(unquotePath(line.slice(4).split("\t")[0] ?? ""));
    } else if (line.startsWith("--- ")) {
      fromOld = stripPrefix(unquotePath(line.slice(4).split("\t")[0] ?? ""));
    }
  }

  if (fromNew && fromNew !== "/dev/null") return fromNew;
  if (fromOld && fromOld !== "/dev/null") return fromOld;

  // Fallback: "diff --git a/path b/path". Assume the halves are equal length.
  const first = headerLines[0] ?? "";
  if (first.startsWith(FILE_START)) {
    const rest = first.slice(FILE_START.length);
    if (rest.startsWith('"')) {
      // Quoted: two quoted strings separated by a space.
      const close = rest.indexOf('" "');
      if (close !== -1) return stripPrefix(unquotePath(rest.slice(0, close + 1)));
    }
    const midpoint = (rest.length - 1) / 2;
    if (Number.isInteger(midpoint) && rest[midpoint] === " ") {
      return stripPrefix(rest.slice(0, midpoint));
    }
    const parts = rest.split(" ");
    const last = parts[parts.length - 1];
    if (last) return stripPrefix(last);
  }

  return "";
}

/**
 * Split a unified diff into per-file patches and individual hunks.
 *
 * Hunk bodies are consumed by the line counts in the @@ header rather than by
 * looking for the next marker. That is what makes the parser safe against
 * content lines that could otherwise be mistaken for structure -- a test
 * fixture containing "diff --git", for instance.
 */
export function parseDiff(unifiedDiff: string): FilePatch[] {
  if (unifiedDiff.trim() === "") return [];

  const lines = unifiedDiff.split("\n");
  const patches: FilePatch[] = [];

  let i = 0;
  // Skip anything before the first file section.
  while (i < lines.length && !lines[i]!.startsWith(FILE_START)) i++;

  while (i < lines.length) {
    const headerLines: string[] = [lines[i]!];
    i++;

    // Header runs until the first hunk, binary payload, or next file.
    while (i < lines.length) {
      const line = lines[i]!;
      if (
        HUNK_HEADER.test(line) ||
        line.startsWith(BINARY_PAYLOAD) ||
        line.startsWith(BINARY_NOTICE) ||
        line.startsWith(FILE_START)
      ) {
        break;
      }
      headerLines.push(line);
      i++;
    }

    const file = resolveFile(headerLines);
    const hunks: Hunk[] = [];
    let binary = false;

    const current = lines[i];
    if (current !== undefined && (current.startsWith(BINARY_PAYLOAD) || current.startsWith(BINARY_NOTICE))) {
      // A binary change is all-or-nothing. Take everything up to the next file
      // section as one indivisible hunk.
      binary = true;
      const body: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith(FILE_START)) {
        body.push(lines[i]!);
        i++;
      }
      // Drop the blank line Git leaves after a binary payload.
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      hunks.push({
        id: `${file}:0`,
        file,
        index: 0,
        patch: `${body.join("\n")}\n`,
        removed: 0,
        added: 0,
        oldStart: 0,
        newStart: 0,
        atomic: true,
      });
    } else {
      while (i < lines.length) {
        const line = lines[i]!;
        const match = HUNK_HEADER.exec(line);
        if (!match) break;

        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);

        const body: string[] = [line];
        i++;

        let oldSeen = 0;
        let newSeen = 0;
        let removed = 0;
        let added = 0;

        while (i < lines.length && (oldSeen < oldCount || newSeen < newCount)) {
          const bodyLine = lines[i]!;
          if (bodyLine.startsWith("\\")) {
            // "\ No newline at end of file" belongs to the hunk but counts
            // toward neither side.
            body.push(bodyLine);
            i++;
            continue;
          }
          const marker = bodyLine[0];
          if (marker === " " || bodyLine === "") {
            oldSeen++;
            newSeen++;
          } else if (marker === "-") {
            oldSeen++;
            removed++;
          } else if (marker === "+") {
            newSeen++;
            added++;
          } else {
            break; // Structure line: the hunk ended early.
          }
          body.push(bodyLine);
          i++;
        }

        // A trailing "\ No newline" can follow the last counted line.
        while (i < lines.length && lines[i]!.startsWith("\\")) {
          body.push(lines[i]!);
          i++;
        }

        const index = hunks.length;
        hunks.push({
          id: `${file}:${index}`,
          file,
          index,
          patch: `${body.join("\n")}\n`,
          removed,
          added,
          oldStart,
          newStart,
          atomic: false,
        });
      }
    }

    if (hunks.length === 0) {
      // Mode change or pure rename: the header alone is the whole change.
      hunks.push({
        id: `${file}:0`,
        file,
        index: 0,
        patch: "",
        removed: 0,
        added: 0,
        oldStart: 0,
        newStart: 0,
        atomic: true,
      });
    }

    patches.push({ file, header: `${headerLines.join("\n")}\n`, hunks, binary });

    // Guard against a malformed section that consumed nothing.
    if (i < lines.length && !lines[i]!.startsWith(FILE_START)) {
      while (i < lines.length && !lines[i]!.startsWith(FILE_START)) i++;
    }
  }

  return patches;
}

/** Flatten parsed file patches into the ordered hunk list the search consumes. */
export function collectHunks(patches: readonly FilePatch[]): Hunk[] {
  return patches.flatMap((patch) => patch.hunks);
}
