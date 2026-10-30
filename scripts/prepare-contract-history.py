"""Prepare private contract history snapshots without changing the source archive.

Standard library only. Originals are never copied, hashed, renamed or modified.
Dates in names are candidates; metadata comparisons do not prove content changes.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import unicodedata

UTC = dt.timezone.utc
DATE_RE = re.compile(r"(?<!\d)(\d{1,2})[.\-_](\d{1,2})[.\-_](20\d{2}|19\d{2}|\d{2})(?!\d)")
DOC_EXTENSIONS = {".pdf", ".doc", ".docx", ".rtf", ".xls", ".xlsx", ".xlsm", ".txt", ".md"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def key(text):
    return unicodedata.normalize("NFC", str(text)).replace("/", "\\").casefold()


def identifier(prefix, value):
    return prefix + hashlib.sha256(key(value).encode("utf-8")).hexdigest()[:24]


def utc_iso(timestamp=None):
    value = dt.datetime.now(UTC) if timestamp is None else dt.datetime.fromtimestamp(timestamp, UTC)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dates_in_name(name):
    candidates = []
    for match in DATE_RE.finditer(name):
        day, month, year = map(int, match.groups())
        year += 2000 if year < 100 else 0
        try:
            date = dt.date(year, month, day).isoformat()
        except ValueError:
            continue
        explicit = bool(re.search(r"\bот\s*$", name[max(0, match.start() - 6):match.start()], re.I))
        candidate = {"date": date, "basis": "filename_after_ot" if explicit else "filename_date",
                     "yearDigits": len(match.group(3))}
        if candidate not in candidates:
            candidates.append(candidate)
    explicit = sorted({v["date"] for v in candidates if v["basis"] == "filename_after_ot"})
    # Two-digit triplets also occur in drawing codes (e.g. АТР_23_12_28).
    # Keep them as possibilities, but select only with an explicit «от» or a four-digit year.
    clear_dates = sorted({v["date"] for v in candidates if v["yearDigits"] == 4})
    selected = explicit[0] if len(explicit) == 1 else clear_dates[0] if not explicit and len(clear_dates) == 1 else None
    return {
        "documentDateCandidate": selected,
        "dateBasis": "filename_after_ot" if selected and explicit else "filename_date" if selected else None,
        "dateCandidates": candidates,
        "dateConfirmed": False,
    }


def classification(name, relative):
    lower = name.casefold()
    if re.search(r"\bдс\s*№?\s*\d|\bдоп(?:олнительное|олнительного|\.)?\s*соглаш", lower):
        kind = "addendum"
    elif re.search(r"\bприложени|\bприл[.\s_№]|\bграфик|\bтехническое\s+задание|\bсмет", lower):
        kind = "appendix"
    elif re.search(r"\bдоговор|\bдгп\b|\bдгсп\b|\bдог[.\s№]", lower):
        kind = "contract"
    elif re.search(r"\bакт\b", lower):
        kind = "act"
    else:
        kind = "other"
    hints = []
    if re.search(r"подписан|(?:^|[\W_])эдо(?:$|[\W_])", relative, re.I):
        hints.append("signed_or_edo_in_path")
    if re.search(r"\bпроект\b|\bчернов|\bред(?:акц|[.\s])|\bзамечан|\bпротокол\s+разноглас", relative, re.I):
        hints.append("draft_or_review_in_path")
    extension = Path(name).suffix.casefold()
    technical = name.casefold() in {"thumbs.db", ".ds_store"} or name.startswith(("~$", "._")) or extension in {".bak", ".lnk", ".log", ".tmp"}
    return {
        "kind": kind, "statusHints": hints, "statusConfirmed": False,
        "technical": technical,
        "documentFormat": extension in DOC_EXTENSIONS or extension in IMAGE_EXTENSIONS,
    }


def project_of(relative):
    parts = Path(relative).parts
    if len(parts) == 1:
        return "_root", "Общие файлы корня", "unassigned"
    if parts[0] == "001 Завершено" and len(parts) > 2:
        return str(Path(parts[0], parts[1])), parts[1], "completed"
    if parts[0] == "Все Договора":
        return parts[0], parts[0], "collection"
    return parts[0], parts[0], "project"


def load_locus(root):
    if root is None:
        return {}, {"status": "not_requested"}
    manifest_path = root / "state" / "manifest.json"
    try:
        raw = manifest_path.read_bytes()
        data = json.loads(raw.decode("utf-8-sig"))
        mapping = {key(v["path"]): v for v in data["files"].values() if v.get("path")}
        return mapping, {"status": "read", "manifestSha256": hashlib.sha256(raw).hexdigest(),
                         "manifestEntries": len(mapping)}
    except (OSError, ValueError, KeyError) as exc:
        return {}, {"status": "unavailable", "error": type(exc).__name__}


def walk(root, errors):
    def visit(folder):
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                        relative = str(Path(entry.path).relative_to(root))
                        if entry.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                            errors.append({"path": relative, "kind": "skipped_reparse_point"})
                        elif stat.S_ISDIR(info.st_mode):
                            yield from visit(Path(entry.path))
                        elif stat.S_ISREG(info.st_mode):
                            yield Path(entry.path), relative, info
                    except OSError as exc:
                        errors.append({"path": str(Path(entry.path).relative_to(root)), "kind": type(exc).__name__})
        except OSError as exc:
            errors.append({"path": str(folder.relative_to(root)), "kind": type(exc).__name__})
    yield from visit(root)


def compare(previous, files, complete):
    if previous is None:
        return {"status": "baseline", "previousSnapshotId": None, "items": []}
    old = {v["id"]: v for v in previous["files"]}
    current = {v["id"]: v for v in files}
    items = []
    for file_id, record in current.items():
        before = old.get(file_id)
        if before is None:
            items.append({"fileId": file_id, "path": record["relativePath"], "kind": "new_path_observed"})
        elif (before["sizeBytes"], before["mtimeNs"]) != (record["sizeBytes"], record["mtimeNs"]):
            items.append({"fileId": file_id, "path": record["relativePath"], "kind": "metadata_changed",
                          "before": {"sizeBytes": before["sizeBytes"], "modifiedAt": before["modifiedAt"]},
                          "after": {"sizeBytes": record["sizeBytes"], "modifiedAt": record["modifiedAt"]}})
    if complete:
        for file_id, record in old.items():
            if file_id not in current:
                items.append({"fileId": file_id, "path": record["relativePath"], "kind": "path_not_observed",
                              "previousFile": record})
    return {"status": "compared" if complete else "partial_comparison",
            "previousSnapshotId": previous["snapshotId"], "items": items,
            "absenceDetectionPerformed": complete,
            "contentChangesVerified": False, "renamesConfirmed": False}


def prepare(source, output, locus_root):
    source = source.resolve(strict=True)
    output = output.resolve()
    if not source.is_dir():
        raise ValueError("Source is not a directory")
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Output must be separate from the source archive")
    if getattr(source.stat(), "st_file_attributes", 0) & 0x400:
        raise ValueError("Reparse source root is not allowed")
    if locus_root and (output == locus_root.resolve() or locus_root.resolve() in output.parents):
        raise ValueError("Output must be separate from Locus data")
    output.mkdir(parents=True, exist_ok=True)
    if output.resolve() != output or getattr(output.stat(), "st_file_attributes", 0) & 0x400:
        raise ValueError("Reparse output is not allowed")
    started = utc_iso()
    source_id = identifier("source-", source)
    snapshot_id = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    locus, locus_meta = load_locus(locus_root)
    previous = None
    for candidate in sorted(output.glob("snapshot-*.json"), reverse=True):
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
            if data.get("sourceId") == source_id and data.get("schemaVersion") == 1:
                previous = data
                break
        except (ValueError, OSError):
            continue
    errors, files, projects = [], [], {}
    for full_path, relative, info in walk(source, errors):
        group_path, title, group_type = project_of(relative)
        project_id = identifier("group-", source_id + ":" + group_path)
        projects.setdefault(project_id, {"id": project_id, "title": title, "path": group_path,
                                        "groupType": group_type, "portalContractId": None, "portalTenderId": None})
        record = {"id": identifier("file-", source_id + ":" + relative), "projectId": project_id,
                  "relativePath": relative, "name": full_path.name, "extension": full_path.suffix.casefold(),
                  "sizeBytes": info.st_size, "mtimeNs": str(info.st_mtime_ns),
                  "modifiedAt": utc_iso(info.st_mtime), "observedAt": utc_iso(),
                  "sha256": None, "contentVerified": False,
                  **dates_in_name(full_path.name), **classification(full_path.name, relative)}
        indexed = locus.get(key(full_path))
        if indexed:
            recognition = indexed.get("recognition") or {}
            quality = indexed.get("quality") or {}
            same = indexed.get("size") == info.st_size and abs(indexed.get("mtimeMs", 0) - info.st_mtime * 1000) < 5
            cache = indexed.get("cacheFile")
            record["locus"] = {
                "indexedAt": indexed.get("indexedAt"), "method": recognition.get("method"),
                "qualityStatus": quality.get("status"), "qualityScore": quality.get("score"),
                "pages": recognition.get("pdfPages") or recognition.get("ocrTotalPages") or recognition.get("ocrPages"),
                "ocrLimited": bool(recognition.get("ocrLimited")),
                "cacheAvailable": bool(cache and Path(cache).is_file()),
                "sourceMatch": "same_metadata" if same else "different_metadata",
                "contentMatchVerified": False,
            }
        files.append(record)
    files.sort(key=lambda v: key(v["relativePath"]))
    finished = utc_iso()
    for project_id, project in projects.items():
        items = [v for v in files if v["projectId"] == project_id]
        project["files"] = len(items)
        project["sizeBytes"] = sum(v["sizeBytes"] for v in items)
        project["kinds"] = dict(collections.Counter(v["kind"] for v in items))
    summary = {"files": len(files), "sizeBytes": sum(v["sizeBytes"] for v in files),
               "groups": len(projects), "documentFormats": sum(v["documentFormat"] and not v["technical"] for v in files),
               "technicalFiles": sum(v["technical"] for v in files),
               "nonTechnicalFiles": sum(not v["technical"] for v in files),
               "dateCandidates": sum(v["documentDateCandidate"] is not None for v in files),
               "ambiguousDates": sum(len({c["date"] for c in v["dateCandidates"]}) > 1 for v in files),
               "locusMatchedPaths": sum("locus" in v for v in files),
               "locusAvailableCaches": sum(v.get("locus", {}).get("cacheAvailable", False) for v in files),
               "extensions": dict(collections.Counter(v["extension"] for v in files))}
    payload = {"schemaVersion": 1, "collectorVersion": "contract-history/2",
               "snapshotId": snapshot_id, "sourceId": source_id, "sourceRoot": str(source),
               "observationStartedAt": started, "observedAt": finished,
               "complete": not errors, "atomicFilesystemSnapshot": False, "hashCoverage": "metadata_only",
               "identityPolicy": "source_and_relative_path; renames_not_inferred",
               "historicalLimit": "Dates from names are candidates. Earlier revisions and signing are not established.",
               "locusManifest": locus_meta, "summary": summary,
               "projects": sorted(projects.values(), key=lambda v: v["title"].casefold()),
               "files": files, "errors": errors, "changes": compare(previous, files, not errors)}
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    json_path = output / ("snapshot-" + snapshot_id + ".json")
    with json_path.open("x", encoding="utf-8") as stream:
        stream.write(raw)
    template = Path(__file__).with_name("templates") / "contract-history.html"
    safe = raw.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    html_path = output / ("history-" + snapshot_id + ".html")
    with html_path.open("x", encoding="utf-8") as stream:
        stream.write(template.read_text(encoding="utf-8").replace("__DATA_JSON__", safe))
    checksum = hashlib.sha256(json_path.read_bytes()).hexdigest()
    (output / ("snapshot-" + snapshot_id + ".sha256")).write_text(checksum + "  " + json_path.name + "\n", encoding="ascii")
    print(json.dumps({"snapshot": str(json_path), "html": str(html_path), "sha256": checksum,
                      "complete": payload["complete"], "summary": summary,
                      "changes": len(payload["changes"]["items"]), "errors": len(errors)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--out-root", required=True, type=Path)
    parser.add_argument("--locus-data", type=Path)
    args = parser.parse_args()
    prepare(args.source_root, args.out_root, args.locus_data)
