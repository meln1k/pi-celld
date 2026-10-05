ALTER TABLE sessions ADD COLUMN cellId TEXT;
ALTER TABLE sessions ADD COLUMN busy INTEGER NOT NULL DEFAULT 0 CHECK (busy IN (0, 1));
CREATE UNIQUE INDEX sessions_cell_id ON sessions (cellId);
