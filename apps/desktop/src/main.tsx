import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./styles/tasks.css";
import "./styles/task-detail.css";
import "./styles/inbox.css";
import "./styles/overview.css";
import "./styles/calendar.css";
import "./styles/notes.css";
import "./styles/projects.css";
import "./styles/settings.css";
import "./styles/palette.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
