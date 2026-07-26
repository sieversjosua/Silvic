import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import {
  isConvexStep,
  type PlotCommand,
  type ProvisionStep,
  type Recipe,
  type RecipeDocument,
  type RepositoryFindings,
} from "@silvic/contracts";

import { ConvexMark } from "./providers";

type CommandEntry = { id: string } & PlotCommand;
type Section = "location" | "commands" | "provision";

const sections: ReadonlyArray<[Section, string]> = [
  ["location", "Location"],
  ["commands", "Commands"],
  ["provision", "Provision"],
];

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
  const [findings, setFindings] = useState<RepositoryFindings>();
  const [section, setSection] = useState<Section>("provision");
  const [directory, setDirectory] = useState("");
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  const [provision, setProvision] = useState<ProvisionStep[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();

  const apply = (recipe: Recipe) => {
    setDirectory(recipe.plots?.directory ?? "");
    setCommands(
      Object.entries(recipe.commands ?? {}).map(([id, command]) => ({
        id,
        ...command,
      })),
    );
    setProvision([...(recipe.provision ?? [])]);
  };

  useEffect(() => {
    void Promise.all([
      window.silvic.getRecipe(projectId),
      window.silvic.inspectProject(projectId),
    ])
      .then(([loaded, inspected]) => {
        setDocument(loaded);
        setFindings(inspected);
        apply(loaded.recipe);
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, [projectId]);

  const draft = useMemo<Recipe>(
    () => ({
      ...(document?.recipe.packageManager
        ? { packageManager: document.recipe.packageManager }
        : findings?.packageManager
          ? { packageManager: findings.packageManager }
          : {}),
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
      ...(provision.length > 0 ? { provision } : {}),
    }),
    [document, findings, directory, commands, provision],
  );

  const save = async () => {
    setSaving(true);
    setFailure(undefined);
    try {
      await window.silvic.saveRecipe({ projectId, recipe: draft });
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
  const patch = (index: number, step: ProvisionStep) =>
    setProvision(provision.map((entry, at) => (at === index ? step : entry)));

  const empty =
    !directory && commands.length === 0 && provision.length === 0;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <section
        className="dialog recipe"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="recipe-title">
          <div>
            <p className="micro">Plot recipe</p>
            <h2>{projectName}</h2>
          </div>
          {document && (
            <p className="micro recipe-path">
              {document.exists ? "silvic.json" : "not yet created"}
            </p>
          )}
        </header>

        {findings && empty && <Suggestion findings={findings} onUse={apply} />}

        <div className="recipe-body">
          <nav className="recipe-rail">
            {sections.map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-active={section === id || undefined}
                onClick={() => setSection(id)}
              >
                {label}
                <span className="mono">
                  {id === "commands"
                    ? commands.length || ""
                    : id === "provision"
                      ? provision.length || ""
                      : ""}
                </span>
              </button>
            ))}
          </nav>

          <div className="recipe-panel">
            {section === "location" && (
              <>
                <label className="dialog-field">
                  <span className="micro">Plots directory</span>
                  <input
                    value={directory}
                    onChange={(event) => setDirectory(event.target.value)}
                    placeholder={
                      document ? `../${document.resolved.project}.plots` : ""
                    }
                  />
                </label>
                <p className="recipe-hint">
                  Where new plots are created, relative to the repository. Left
                  empty, plots go beside it in a folder named after the project.
                </p>
              </>
            )}

            {section === "commands" && (
              <>
                <div className="recipe-head">
                  <span className="micro">What runs in a plot</span>
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
                            at === index
                              ? { ...entry, id: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                    <input
                      value={command.run}
                      placeholder="bun run dev"
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
                <p className="recipe-hint">
                  Commands are recorded but not started yet — running them needs
                  process supervision, which is still to be decided.
                </p>
              </>
            )}

            {section === "provision" && (
              <>
                <div className="recipe-head">
                  <span className="micro">Runs in order, once, at creation</span>
                  <div className="recipe-add">
                    <button
                      type="button"
                      onClick={() => setProvision([...provision, { run: "" }])}
                    >
                      <Terminal size={12} /> Command
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setProvision([
                          ...provision,
                          { convex: { name: "dev/{plot}" } },
                        ])
                      }
                    >
                      <ConvexMark size={12} /> Convex
                    </button>
                  </div>
                </div>
                {provision.length === 0 && (
                  <p className="section-empty">
                    A new plot gets its files and nothing else.
                  </p>
                )}
                {provision.map((step, index) => (
                  <div className="recipe-step" key={index}>
                    <div className="recipe-step-head">
                      <span className="micro">
                        {isConvexStep(step) ? (
                          <>
                            <ConvexMark size={12} /> Convex deployment
                          </>
                        ) : (
                          <>
                            <Terminal size={11} /> Command
                          </>
                        )}
                      </span>
                      <div className="recipe-step-tools">
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
                            setProvision(
                              provision.filter((_, at) => at !== index),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                    {isConvexStep(step) ? (
                      <div className="recipe-grid">
                        <label>
                          <span className="micro">Team</span>
                          <input
                            value={step.convex.team ?? ""}
                            placeholder="from .env.local"
                            onChange={(event) =>
                              patch(index, {
                                ...step,
                                convex: {
                                  ...step.convex,
                                  team: event.target.value || undefined,
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          <span className="micro">Project</span>
                          <input
                            value={step.convex.project ?? ""}
                            placeholder="from .env.local"
                            onChange={(event) =>
                              patch(index, {
                                ...step,
                                convex: {
                                  ...step.convex,
                                  project: event.target.value || undefined,
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          <span className="micro">Deployment name</span>
                          <input
                            className="mono"
                            value={step.convex.name}
                            onChange={(event) =>
                              patch(index, {
                                ...step,
                                convex: {
                                  ...step.convex,
                                  name: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                        <p className="recipe-hint">
                          <code>{"{plot}"}</code> becomes the plot's name. Team
                          and project left empty are read from the source
                          checkout's <code>CONVEX_DEPLOYMENT</code>.
                        </p>
                      </div>
                    ) : (
                      <div className="recipe-row">
                        <input
                          className="recipe-id"
                          value={step.label ?? ""}
                          placeholder={`Step ${index + 1}`}
                          onChange={(event) =>
                            patch(index, {
                              ...step,
                              label: event.target.value || undefined,
                            })
                          }
                        />
                        <input
                          className="mono"
                          value={step.run}
                          placeholder="bun install"
                          onChange={(event) =>
                            patch(index, { ...step, run: event.target.value })
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
                <p className="recipe-hint">
                  Steps run in the new plot with <code>SILVIC_ROOT</code>,{" "}
                  <code>SILVIC_PLOT</code> and <code>SILVIC_URL</code> set. The{" "}
                  <code>WORK_*</code> names are set too, so an existing work-cli
                  setup hook runs unchanged.
                </p>
              </>
            )}
          </div>
        </div>

        {showJson && (
          <pre className="patch mono">
            {JSON.stringify(draft, undefined, 2)}
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

/**
 * Most repositories describe themselves well enough to start from, so the
 * editor offers that rather than opening on a blank page.
 */
function Suggestion({
  findings,
  onUse,
}: {
  findings: RepositoryFindings;
  onUse(recipe: Recipe): void;
}) {
  const seen = [
    findings.packageManager,
    findings.devScript ? `"${findings.devScript}" script` : undefined,
    findings.convex ? "convex/" : undefined,
    findings.envExample,
    findings.workConfig ? "work.config.js" : undefined,
  ].filter((item) => item !== undefined);

  if (seen.length === 0) return null;
  return (
    <div className="recipe-suggestion">
      {findings.convex ? <ConvexMark size={15} /> : <Sparkles size={13} />}
      <div>
        <strong>Found {seen.join(" · ")}</strong>
        <span>Silvic can propose a recipe from this.</span>
      </div>
      <button
        type="button"
        className="ghost-button"
        onClick={() => onUse(suggestFrom(findings))}
      >
        Use as a start
      </button>
    </div>
  );
}

/** Mirrors core's suggestion so the editor can offer it before saving. */
function suggestFrom(findings: RepositoryFindings): Recipe {
  const manager = findings.packageManager;
  const provision: ProvisionStep[] = [];
  if (manager) {
    provision.push({ label: "Install dependencies", run: `${manager} install` });
  }
  if (findings.envExample) {
    provision.push({
      label: "Environment file",
      run: `cp "$SILVIC_SOURCE_ROOT/.env.local" .env.local 2>/dev/null || cp ${findings.envExample} .env.local`,
    });
  }
  if (findings.convex) provision.push({ convex: { name: "dev/{plot}" } });

  return {
    ...(manager ? { packageManager: manager } : {}),
    ...(provision.length > 0 ? { provision } : {}),
    ...(findings.devScript && manager
      ? {
          commands: {
            web: {
              run: `${manager} run ${findings.devScript}`,
              url: true,
              autoStart: true,
            },
          },
        }
      : {}),
  };
}
