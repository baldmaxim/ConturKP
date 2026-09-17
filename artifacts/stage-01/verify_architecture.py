"""Проверки документов этапа 01.

1. Все обязательные документы на месте.
2. Каждый ADR содержит обязательные разделы и статус.
3. Инварианты I01–I19 описаны с механизмом, этапом и проверкой.
4. Сценарии A01–A46 присутствуют в плане тестирования.
5. Сущности спецификации §4 присутствуют в модели данных.
6. Обязательные машины состояний описаны.
7. Пять сквозных сценариев на бумаге присутствуют.
8. Каждое неизвестное Q/U/X имеет владельца, влияние и изоляцию; ни одно не требует переделки ядра.
9. Все ID Q/U/X/R, упомянутые в документах, определены (реестр этапа 01 или discovery).
10. Относительные ссылки в документах ведут на существующие файлы.
11. Документы — валидный UTF-8 без строк, похожих на секреты (шаблоны не исчерпывающие).
12. В трассировке у каждого требования заполнена колонка «Реализация».

Итог и код выхода: PASS 0, FAIL 1. Только чтение.

Запуск из корня репозитория портала:
    python artifacts/stage-01/verify_architecture.py [--root ПУТЬ]
"""

import argparse
import dataclasses
import pathlib
import re
import sys

PASS, FAIL = "PASS", "FAIL"

ADR_FILES = [
    "ADR-001-stack-and-processes.md",
    "ADR-002-postgresql-and-migrations.md",
    "ADR-003-file-storage.md",
    "ADR-004-durable-job-queue.md",
    "ADR-005-money-time-concurrency-idempotency.md",
    "ADR-006-access-roles-isolation.md",
    "ADR-007-sources-of-truth-and-adapters.md",
    "ADR-008-search-scope.md",
    "ADR-009-model-and-rules.md",
    "ADR-010-portal-mcp.md",
    "ADR-011-deployment-backup-restore.md",
]
ADR_SECTIONS = ["## Контекст", "## Решение", "## Альтернативы", "## Последствия", "## Проверка", "## Связанные требования"]
DOCS = [
    "docs/adr/README.md",
    *[f"docs/adr/{name}" for name in ADR_FILES],
    "docs/architecture/overview.md",
    "docs/architecture/data-model.md",
    "docs/architecture/state-machines.md",
    "docs/architecture/invariants.md",
    "docs/architecture/walkthroughs.md",
    "docs/architecture/test-plan.md",
    "docs/architecture/unknowns.md",
    "docs/contracts/portal-api.md",
    "docs/contracts/adapters.md",
    "docs/contracts/mcp-tools.md",
    "docs/requirements-traceability.md",
    "docs/project-state.md",
    "docs/decisions.md",
    "docs/stages/01-report.md",
]
# Сущности спецификации §4 → канонические таблицы модели данных.
ENTITIES = {
    "Tender": "tender",
    "TenderStage": "tender_stage",
    "CalculationRevision": "calculation_revision",
    "Document": "document",
    "DocumentRevision": "document_revision",
    "RecognitionRun": "recognition_run",
    "EvidenceFragment": "evidence_fragment",
    "SourceSetRevision": "source_set_revision",
    "Requirement": "requirement",
    "CoverageLink": "coverage_link",
    "Communication": "communication",
    "QuestionAnswer": "qa_item",
    "Negotiation": "negotiation_session",
    "Decision": "decision",
    "Discrepancy": "discrepancy",
    "Finding": "finding",
    "ApplicationTemplate": "application_template",
    "ApplicationDraft": "application_draft",
    "ReviewRun": "review_run",
    "ReleaseCandidate": "release_candidate",
    "Approval": "approval",
    "Release": "release",
    "Delivery": "delivery",
    "SendEvent": "send_event",
    "ChangeExplanation": "change_explanation",
    "AuditEvent": "audit_event",
    "Job": "job",
}
STATE_MACHINES = [
    "job",
    "recognition_run",
    "source_set_revision",
    "calculation_capture",
    "requirement",
    "review_run",
    "model_suggestion",
    "finding",
    "release_candidate",
    "approval",
    "release",
    "readiness_hold",
    "delivery",
    "send_event",
    "comparison",
    "integration_status",
]
WALKTHROUGH_HEADINGS = 5
SECRET_RE = re.compile(
    r"thk_[A-Za-z0-9]{8,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{16,}"
    r"|postgres(?:ql)?://[^\s:@/]+:[^\s@/]+@"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY"
    r"|AKIA[0-9A-Z]{16}"
    r"|sk-[A-Za-z0-9]{20,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."
)
ID_RE = re.compile(r"\b([XQUR]-\d{2})\b")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)#]+?)(?:#[^)]*)?\)")


@dataclasses.dataclass(frozen=True)
class Result:
    status: str
    name: str
    detail: str = ""


def read(root, rel):
    return (root / rel).read_text(encoding="utf-8")


def check_files(root):
    missing = [rel for rel in DOCS if not (root / rel).is_file()]
    return [Result(FAIL if missing else PASS, f"обязательные документы ({len(DOCS)})", ", ".join(missing))]


def check_adrs(root):
    results = []
    for name in ADR_FILES:
        rel = f"docs/adr/{name}"
        if not (root / rel).is_file():
            results.append(Result(FAIL, f"ADR {name}", "файл отсутствует"))
            continue
        text = read(root, rel)
        missing = [section for section in ADR_SECTIONS if section not in text]
        if "Статус:" not in text:
            missing.append("Статус:")
        results.append(Result(FAIL if missing else PASS, f"ADR {name}", "нет разделов: " + ", ".join(missing) if missing else ""))
    return results


def table_rows(text, id_pattern):
    """Возвращает {id: [ячейки]} для строк markdown-таблицы, начинающихся с ID."""
    rows = {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and re.fullmatch(id_pattern, cells[0]):
            rows[cells[0]] = cells
    return rows


def check_invariants(root):
    rows = table_rows(read(root, "docs/architecture/invariants.md"), r"I\d{2}")
    missing = [f"I{n:02d}" for n in range(1, 20) if f"I{n:02d}" not in rows]
    empty = [key for key, cells in rows.items() if len(cells) < 5 or not cells[2] or not cells[3] or not cells[4]]
    detail = "; ".join(filter(None, ["нет строк: " + ", ".join(missing) if missing else "", "пустые колонки: " + ", ".join(empty) if empty else ""]))
    return [Result(FAIL if missing or empty else PASS, "инварианты I01–I19 с механизмом и проверкой", detail)]


def check_cases(root):
    text = read(root, "docs/architecture/test-plan.md")
    rows = table_rows(text, r"A\d{2}")
    missing = [f"A{n:02d}" for n in range(1, 47) if f"A{n:02d}" not in rows]
    return [Result(FAIL if missing else PASS, "сценарии A01–A46 в плане тестирования", ", ".join(missing))]


def check_entities(root):
    text = read(root, "docs/architecture/data-model.md")
    missing = [f"{entity} → {table}" for entity, table in ENTITIES.items() if f"`{table}`" not in text]
    return [Result(FAIL if missing else PASS, f"сущности спецификации §4 ({len(ENTITIES)})", ", ".join(missing))]


def check_state_machines(root):
    text = read(root, "docs/architecture/state-machines.md")
    missing = [name for name in STATE_MACHINES if f"`{name}`" not in text]
    return [Result(FAIL if missing else PASS, f"машины состояний ({len(STATE_MACHINES)})", ", ".join(missing))]


def check_walkthroughs(root):
    text = read(root, "docs/architecture/walkthroughs.md")
    headings = re.findall(r"^## \d+\. ", text, re.M)
    ok = len(headings) >= WALKTHROUGH_HEADINGS
    return [Result(PASS if ok else FAIL, "сквозные сценарии на бумаге", f"найдено {len(headings)}, нужно {WALKTHROUGH_HEADINGS}")]


def unknown_rows(root):
    return table_rows(read(root, "docs/architecture/unknowns.md"), r"[XQU]-\d{2}")


def check_unknowns(root):
    rows = unknown_rows(root)
    results = []
    if not rows:
        return [Result(FAIL, "реестр неизвестных", "строк не найдено")]
    incomplete, core = [], []
    for key, cells in rows.items():
        # Вопросы и технические неизвестные: ID | текст | владелец | влияние | изоляция | этап | до ответа
        # Доработки: ID | система | владелец | влияние | изоляция | этап
        if len(cells) < 5 or not cells[2] or not cells[3] or not cells[4]:
            incomplete.append(key)
            continue
        if "ядро" in cells[4]:
            core.append(key)
    results.append(Result(FAIL if incomplete else PASS, f"у неизвестных есть владелец, влияние и изоляция ({len(rows)})", ", ".join(incomplete)))
    results.append(Result(FAIL if core else PASS, "ни одно неизвестное не требует переделки ядра", ", ".join(core)))
    return results


def check_ids_defined(root):
    defined = set(unknown_rows(root))
    discovery = root / "docs/discovery.md"
    if discovery.is_file():
        defined |= set(re.findall(r"^\| ([XQUR]-\d{2}) \|", discovery.read_text(encoding="utf-8"), re.M))
    used = set()
    for rel in DOCS:
        path = root / rel
        if path.is_file():
            used |= set(ID_RE.findall(path.read_text(encoding="utf-8")))
    undefined = sorted(used - defined)
    return [Result(FAIL if undefined else PASS, f"ID Q/U/X/R определены ({len(defined)})", ", ".join(undefined))]


def check_links(root):
    broken = []
    for rel in DOCS:
        path = root / rel
        if not path.is_file():
            continue
        for target in LINK_RE.findall(path.read_text(encoding="utf-8")):
            if re.match(r"^[a-z]+:", target) or target.startswith("#"):
                continue
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{rel} → {target}")
    return [Result(FAIL if broken else PASS, "относительные ссылки ведут на существующие файлы", "; ".join(broken[:10]))]


def check_text(root):
    results = []
    for rel in DOCS:
        path = root / rel
        if not path.is_file():
            continue
        try:
            text = path.read_bytes().decode("utf-8")
        except UnicodeDecodeError as error:
            results.append(Result(FAIL, f"UTF-8: {rel}", str(error)))
            continue
        hits = SECRET_RE.findall(text)
        if hits:
            results.append(Result(FAIL, f"нет секретов: {rel}", f"совпадений: {len(hits)}"))
    if not results:
        results.append(Result(PASS, f"UTF-8 и нет секретов ({len(DOCS)} документов)"))
    return results


def check_traceability(root):
    rows = table_rows(read(root, "docs/requirements-traceability.md"), r"[IFC]\d{2}")
    empty = [key for key, cells in rows.items() if len(cells) < 4 or not cells[3] or cells[3] == "—"]
    return [Result(FAIL if empty else PASS, f"в трассировке заполнена колонка «Реализация» ({len(rows)})", ", ".join(empty))]


def run(root):
    results = []
    results += check_files(root)
    results += check_adrs(root)
    results += check_invariants(root)
    results += check_cases(root)
    results += check_entities(root)
    results += check_state_machines(root)
    results += check_walkthroughs(root)
    results += check_unknowns(root)
    results += check_ids_defined(root)
    results += check_links(root)
    results += check_text(root)
    results += check_traceability(root)
    return results


def summarize(results):
    return ("FAIL", 1) if any(result.status == FAIL for result in results) else ("PASS", 0)


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Проверки документов этапа 01")
    parser.add_argument("--root", default=str(repo_root), help="корень репозитория портала")
    args = parser.parse_args(argv)
    root = pathlib.Path(args.root).resolve()
    results = run(root)
    verdict, code = summarize(results)
    for result in results:
        print(f"{result.status:<6} {result.name}{(' — ' + result.detail) if result.detail else ''}")
    print("\nПроверяется согласованность документов, а не корректность архитектурных решений.")
    print(f"Итог: {verdict} (код {code})")
    return code


if __name__ == "__main__":
    sys.exit(main())
