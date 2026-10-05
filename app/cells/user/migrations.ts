import type { MigrationDescriptor } from "remix/data-table";
import createUserTables from "./migrations/0001_create_user_tables/up.sql" with { type: "text" };
import sessionActivity from "./migrations/0002_session_activity/up.sql" with { type: "text" };
import sessionChildren from "./migrations/0003_session_children/up.sql" with { type: "text" };

// Text imports preserve the exact SQL bytes and bundle without runtime filesystem access.
export const userMigrations: MigrationDescriptor[] = [
  { id: "0001", name: "create_user_tables", up: createUserTables },
  { id: "0002", name: "session_activity", up: sessionActivity },
  { id: "0003", name: "session_children", up: sessionChildren },
];
