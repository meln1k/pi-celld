ALTER TABLE sessions ADD COLUMN parentId TEXT REFERENCES sessions(id);
CREATE INDEX sessions_parent_id ON sessions (parentId);
