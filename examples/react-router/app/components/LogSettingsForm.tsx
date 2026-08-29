import { useSignals } from "react-fine-grained-signals";
import type { DeepSignal } from "react-fine-grained-signals";

export interface LogSettings {
  maxVisible: number;
  reverseOrder: boolean;
}

/** Owns its own tracking scope, separate from the route component. */
export function LogSettingsForm({ settings }: { settings: DeepSignal<LogSettings> }) {
  useSignals();

  return (
    <div className="log-settings">
      <label>
        表示件数:{" "}
        <input
          type="number"
          min={3}
          max={10}
          value={settings.value.maxVisible}
          onChange={(event) => {
            settings.value.maxVisible = Number(event.target.value);
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.value.reverseOrder}
          onChange={(event) => {
            settings.value.reverseOrder = event.target.checked;
          }}
        />
        古い順に表示
      </label>
    </div>
  );
}
