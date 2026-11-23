import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SpikeInfo = {
  api: string;
  token: string;
  events: number;
  log_path: string;
  aumid: string;
};

// Phase 0 spike screen: shows core status and triggers a test toast.
export default function App() {
  const [info, setInfo] = useState<SpikeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    invoke<SpikeInfo>("spike_info").then(setInfo).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main style={{ fontFamily: "Segoe UI, sans-serif", padding: 24, lineHeight: 1.6 }}>
      <h1>Tether — Phase 0 spike</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {info && (
        <dl>
          <dt>Local API</dt>
          <dd>{info.api}</dd>
          <dt>Token (spike only)</dt>
          <dd style={{ wordBreak: "break-all" }}>{info.token}</dd>
          <dt>DB events</dt>
          <dd>{info.events}</dd>
          <dt>Toast AUMID</dt>
          <dd>{info.aumid}</dd>
          <dt>Log file</dt>
          <dd>{info.log_path}</dd>
        </dl>
      )}
      <button onClick={() => invoke("spike_toast")}>Send test notification</button>{" "}
      <button onClick={refresh}>Refresh</button>
    </main>
  );
}
