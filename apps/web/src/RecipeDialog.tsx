import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";

import type {
  PlotCommand,
  ProvisionStep,
  Recipe,
  RecipeDocument,
} from "@silvic/contracts";

type CommandEntry = { id: string } & PlotCommand;

/**
 * The recipe is a file in the repository, so the editor never hides that: it
 * names the path it writes and can show the exact JSON before saving.
 */
export function RecipeDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose(): void;
}) {
  const [document, setDocument] = useState<RecipeDocument>();
  const [directory, setDirectory] = useState("");
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  const [provision, setProvision] = useState<ProvisionStep[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    void window.silvic
      .getRecipe(projectId)
      .then((loaded) => {
        setDocument(loaded);
        setDirectory(loaded.recipe.plots?.directory ?? "");
        setCommands(
          Object.entries(loaded.recipe.commands ?? {}).map(([id, command]) => ({
            id,
            ...command,
          })),
        );
        setProvision([...(loaded.recipe.provision ?? [])]);
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, [projectId]);

  const draft = (): Recipe => ({
    ...(directory.trim() ? { plots: { directory: directory.trim() } } : {}),
    ...(commands.length > 0
      ? {
          commands: Object.fromEntries(
            commands
              .filter((command) => command.id && command.run.trim())
              .map(({ id, ...command }) => [id, command]),
          ),
        }
      : {}),
    ...(provision.length > 0
      ? {
          provision: provision
            .filter((step) => step.run.trim())
            .map((step) => ({
              run: step.run.trim(),
              ...(step.label?.trim() ? { label: step.label.trim() } : {}),
            })),
        }
      : {}),
  });

  const save = async () => {
    setSaving(true);
    setFailure(undefined);
    try {
      setDocument(
        await window.silvic.saveRecipe({ projectId, recipe: draft() }),
      );
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  const move = (index: number, by: number) => {
    const next = [...provision];
    const [step] = next.splice(index, 1);
    if (step) next.splice(index + by, 0, step);
    setProvision(next);
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <section
        className="dialog recipe"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">Plot recipe</p>
        <h2>{projectName}</h2>
        <p className="dialog-copy">
          How a new plot is built for this project. Every field is optional — a
          project without a recipe still gets a worktree, a name and an address.
        </p>

        <label className="dialog-field">
          <span className="micro">Plots directory</span>
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={
              document ? `../${document.resolved.project}.plots` : "…"
            }
          />
        </label>

        <section className="recipe-section">
          <div className="recipe-head">
            <span className="micro">Commands</span>
            <button
              type="button"
              onClick={() =>
                setCommands([...commands, { id: "", run: "", url: true }])
              }
            >
              <Plus size={12} /> Add
            </button>
          </div>
          {commands.length === 0 && (
            <p className="section-empty">
              Nothing runs in a plot yet.
            </p>
          )}
          {commands.map((command, index) => (
            <div className="recipe-row" key={index}>
              <input
                className="recipe-id mono"
                value={command.id}
                placeholder="web"
                onChange={(event) =>
                  setCommands(
                    commands.map((entry, at) =>
                      at === index ? { ...entry, id: event.target.value } : entry,
                    ),
                  )
                }
              />
              <input
                value={command.run}
                placeholder="bun dev"
                onChange={(event) =>
                  setCommands(
                    commands.map((entry, at) =>
                      at === index
                        ? { ...entry, run: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label="Remove command"
                onClick={() =>
                  setCommands(commands.filter((_, at) => at !== index))
                }
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </section>

        <section className="recipe-section">
          <div className="recipe-head">
            <span className="micro">Provision · runs in order</span>
            <button
              type="button"
              onClick={() => setProvision([...provision, { run: "" }])}
            >
              <Plus size={12} /> Add
            </button>
          </div>
          {provision.length === 0 && (
            <p className="section-empty">
              A new plot gets its files and nothing else.
            </p>
          )}
          {provision.map((step, index) => (
            <div className="recipe-row provision" key={index}>
              <input
                className="recipe-id"
                value={step.label ?? ""}
                placeholder={`Step ${index + 1}`}
                onChange={(event) =>
                  setProvision(
                    provision.map((entry, at) =>
                      at === index
                        ? { ...entry, label: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
              <input
                className="mono"
                value={step.run}
                placeholder="bun install"
                onChange={(event) =>
                  setProvision(
                    provision.map((entry, at) =>
                      at === index ? { ...entry, run: event.target.value } : entry,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label="Move earlier"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                aria-label="Move later"
                disabled={index === provision.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={12} />
              </button>
              <button
                type="button"
                aria-label="Remove step"
                onClick={() =>
                  setProvision(provision.filter((_, at) => at !== index))
                }
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <p className="recipe-hint">
            Steps run in the new plot with <code>SILVIC_ROOT</code>,{" "}
            <code>SILVIC_PLOT</code> and <code>SILVIC_URL</code> set. The{" "}
            <code>WORK_*</code> names are set too, so an existing work-cli setup
            hook runs unchanged.
          </p>
        </section>

        {showJson && (
          <pre className="patch mono">
            {JSON.stringify(draft(), undefined, 2)}
          </pre>
        )}
        {document && (
          <p className="destination mono">
            {document.exists ? "Writes to" : "Creates"} {document.path}
          </p>
        )}
        {failure && <p className="dialog-error">{failure}</p>}

        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setShowJson(!showJson)}
          >
            {showJson ? "Hide" : "Review"} changes
          </button>
          <span className="dialog-spacer" />
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!document || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save recipe"}
          </button>
        </div>
      </section>
    </div>
  );
}
