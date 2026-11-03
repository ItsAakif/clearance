// T1005 fixture (d) - USER-SUPPLIED .wasm PLUGIN LOAD.
//
// Policy 8.2 B7 / section 5.5 / risk R7 / assertion V8. TWO separate guarantees, and the
// spike proves both, because either alone would be the wrong claim:
//
//   (1) STAGING GATE. A `.wasm` is not on the staged-name allowlist (policy 5.1:
//       `template.typ`, `data.json`, and declared assets only), so the staging audit
//       rejects the job before typst starts. Nothing named `*.wasm` can reach /work.
//       Measured, from the same audit that catches the symlink in fixture (b):
//           REJECT-NAME: plugin.wasm
//
//   (2) STRUCTURAL GATE. If the audit is bypassed and a VALID WebAssembly module is
//       planted in the root anyway, typst still refuses to load it:
//
//       MEASURED: template.typ:32:23: error: unresolved import
//                 exit 1, /out empty
//
//       Typst plugins are only ever resolved as
//       `<package-path>/<namespace>/<name>/<version>/plugin.wasm`. A project root is
//       not a package, so there is no code path from a root-resident `.wasm` to the
//       plugin loader. The file is reachable as BYTES (`read()` is a read-only API) and
//       inert.
//
// The `plugin.wasm` beside this file is a genuinely VALID WebAssembly module - the
// 8-byte empty module, `00 61 73 6d 01 00 00 00`, sha256
// 93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476 - not a malformed
// decoy. A successful load would therefore be attributable to typst, not to a parse error.
//
// THE GUARANTEE IS PRECISE, and the precise form matters: "no USER-SUPPLIED .wasm", not
// "no .wasm ever". A `.wasm` inside the vendored, review-controlled tree at
// /opt/typst-packages WOULD be loaded, and that is accepted, because the vendored tree is
// reviewed and licence-recorded and is never populated from user input. Stating it as
// "no .wasm ever" would be false and would fail review.
//
// Attempt 2 below is unreachable after attempt 1 errors, and is documented rather than
// removed: it names a namespace that is not in packages.lock, so it can never resolve,
// which is the policy 8.3 registry gate expressed as code.

#set page(paper: "a4", margin: 20mm)
#set text(font: "Source Serif 4", size: 10pt)

// Attempt 1: treat the root-resident module as importable Typst source.
#import "plugin.wasm": run
#run()

// Attempt 2: reference a package that would own a plugin. Not in packages.lock.
#import "@evil/exfil:1.0.0": exfil
#exfil()
