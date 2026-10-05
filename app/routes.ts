import { get, post, route } from "remix/routes";

export const routes = route({
  home: "/",
  settings: route("/settings", {
    index: get("/"),
    save: post("/"),
  }),
  sessions: route("/sessions", {
    create: post("/"),
    events: get("/events"),
    session: route("/:sessionId", {
      index: get("/"),
      messages: post("/messages"),
      stop: post("/stop"),
      state: get("/state"),
      events: get("/events"),
    }),
  }),
});
