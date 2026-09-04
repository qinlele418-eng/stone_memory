CREATE TABLE IF NOT EXISTS ai_reports (
  repository TEXT NOT NULL,
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  version TEXT NOT NULL,
  report_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (repository, kind, number, version)
);
