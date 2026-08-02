import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Play,
  Plus,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import {
  isConvexStep,
  type PlotCommand,
  type PlotResourceDefinition,
  type PlotResourceProvider,
  type ProvisionStep,
  type Recipe,
  type PlotPreview,
  type ProvisionResult,
  type RecipeDocument,
  type RecipeSuggestion,
  type RepositoryFindings,
  type RepositoryReading,
  type ShellStep,
} from "@silvic/contracts";

import { ConvexMark } from "./providers";
import { failureMessage } from "./errors";

type CommandEntry = { id: string } & PlotCommand;
type ResourceEntry = { id: string } & PlotResourceDefinition;
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
  const [adding, setAdding] = useState<
    "provision" | "commands" | "resources"
  >();
  const [reading, setReading] = useState<RepositoryReading>();
  const findings = reading?.findings;
  const stepSuggestions = reading?.steps ?? [];
  const commandSuggestions = reading?.commands ?? [];
  const [directory, setDirectory] = useState("");
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  const [resources, setResources] = useState<ResourceEntry[]>([]);
  const [provision, setProvision] = useState<ProvisionStep[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [sampleBranch, setSampleBranch] = useState("my-branch");
  const [preview, setPreview] = useState<PlotPreview>();
  const [tests, setTests] = useState<
    Record<number, ProvisionResult | "running">
  >({});
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
    setResources(
      Object.entries(recipe.resources ?? {}).map(([id, resource]) => ({
        id,
        ...resource,
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
        setReading(inspected);
        apply(loaded.recipe);
      })
      .catch((error: unknown) => setFailure(failureMessage(error)));
  }, [projectId]);

  // The preview is computed by the main process using the same functions that
  // creation uses, so what it shows is what will actually happen.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void window.silvic
        .previewPlot({ projectId, branch: sampleBranch })
        .then(setPreview)
        .catch(() => setPreview(undefined));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [projectId, sampleBranch, directory]);

  const runTest = async (index: number, step: ShellStep) => {
    setTests((current) => ({ ...current, [index]: "running" }));
    try {
      const result = await window.silvic.testProvisionStep({ projectId, step });
      setTests((current) => ({ ...current, [index]: result }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [index]: {
          label: step.label ?? "Step",
          command: step.run,
          exitCode: 1,
          output: failureMessage(error),
          durationMs: 0,
        },
      }));
    }
  };

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
      ...(resources.length > 0
        ? {
            resources: Object.fromEntries(
              resources
                .filter((resource) => resource.id.trim())
                .map(({ id, ...resource }) => [id, resource]),
            ),
          }
        : {}),
      ...(provision.length > 0 ? { provision } : {}),
    }),
    [document, findings, directory, commands, resources, provision],
  );

  const save = async () => {
    setSaving(true);
    setFailure(undefined);
    try {
      await window.silvic.saveRecipe({ projectId, recipe: draft });
      onClose();
    } catch (error) {
      setFailure(failureMessage(error));
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
    !directory &&
    commands.length === 0 &&
    resources.length === 0 &&
    provision.length === 0;

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
          <div className="recipe-panel">
            <section className="recipe-part">
              <div className="recipe-part-title">
                <h3>Where a plot lands</h3>
                <p>A directory beside the repository, one folder per plot.</p>
              </div>
              <label className="dialog-field">
                <input
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder={
                    document ? `../${document.resolved.project}.plots` : ""
                  }
                />
              </label>
            </section>

            <section className="recipe-part">
              <div className="recipe-part-title">
                <h3>Once, when it is made</h3>
                <p>Ordered, and finished before the plot is handed over.</p>
                <div className="recipe-actions">
                  <AddMenu
                    open={adding === "provision"}
                    onOpen={() =>
                      setAdding(
                        adding === "provision" ? undefined : "provision",
                      )
                    }
                    onClose={() => setAdding(undefined)}
                    suggestions={stepSuggestions.filter(
                      (suggestion) =>
                        !provision.some((step) => sameStep(step, suggestion)),
                    )}
                    onPick={(suggestion) => {
                      if (suggestion.step) {
                        setProvision([...provision, suggestion.step]);
                      }
                    }}
                    blanks={[
                      {
                        id: "blank-command",
                        label: "Command",
                        detail: "Anything this repository needs run once",
                        icon: <Terminal size={12} />,
                        add: () => setProvision([...provision, { run: "" }]),
                      },
                      {
                        id: "blank-convex",
                        label: "Convex deployment",
                        detail: "A deployment of its own for the plot",
                        icon: <ConvexMark size={12} />,
                        add: () =>
                          setProvision([
                            ...provision,
                            { convex: { name: "dev/{plot}" } },
                          ]),
                      },
                    ]}
                  />
                </div>
              </div>
              {provision.length === 0 && (
                <p className="section-empty">
                  A new plot gets its files and nothing else.
                </p>
              )}
              {provision.map((step, index) => (
                <div className="recipe-step" key={index}>
                  <span className="recipe-step-kind" aria-hidden="true">
                    {isConvexStep(step) ? (
                      <ConvexMark size={13} />
                    ) : (
                      <Terminal size={12} />
                    )}
                  </span>
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
                      <label>
                        <span className="micro">Expires</span>
                        <input
                          className="mono"
                          value={step.convex.expiration ?? ""}
                          placeholder="never, or in 7 days"
                          onChange={(event) =>
                            patch(index, {
                              ...step,
                              convex: {
                                ...step.convex,
                                expiration: event.target.value || undefined,
                              },
                            })
                          }
                        />
                      </label>
                      <p className="micro">
                        Silvic copies the local environment, creates a scoped
                        deploy key, syncs server variables, and pushes Convex
                        once with its own compatible CLI. The repository
                        dependency is left unchanged.
                      </p>
                    </div>
                  ) : (
                    <>
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
                        <button
                          type="button"
                          aria-label="Test this step"
                          title="Run once in the primary checkout"
                          disabled={
                            !step.run.trim() || tests[index] === "running"
                          }
                          onClick={() => void runTest(index, step)}
                        >
                          <Play size={12} />
                        </button>
                      </div>
                    </>
                  )}
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
                        setProvision(provision.filter((_, at) => at !== index))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <StepTest result={tests[index]} />
                </div>
              ))}
              <p className="recipe-hint">
                Custom commands receive the plot's <code>SILVIC_*</code>,
                <code>HOST</code>, and <code>PORT</code> context. Typed provider
                steps stay owned by Silvic.
              </p>
            </section>

            <section className="recipe-part">
              <div className="recipe-part-title">
                <h3>While you work</h3>
                <p>
                  Started and stopped from the plot, for as long as you need
                  them.
                </p>
                <div className="recipe-actions">
                  <AddMenu
                    open={adding === "commands"}
                    onOpen={() =>
                      setAdding(adding === "commands" ? undefined : "commands")
                    }
                    onClose={() => setAdding(undefined)}
                    suggestions={commandSuggestions.filter(
                      (suggestion) =>
                        !commands.some(
                          (entry) => entry.id === suggestion.command?.id,
                        ),
                    )}
                    onPick={(suggestion) => {
                      if (!suggestion.command) return;
                      setCommands([
                        ...commands,
                        {
                          id: suggestion.command.id,
                          run: suggestion.command.command.run,
                          url: suggestion.command.command.url ?? false,
                        },
                      ]);
                    }}
                    blanks={[
                      {
                        id: "blank-command",
                        label: "Command",
                        detail: "Anything that runs while you work",
                        icon: <Terminal size={12} />,
                        add: () =>
                          setCommands([
                            ...commands,
                            { id: "", run: "", url: true },
                          ]),
                      },
                    ]}
                  />
                </div>
              </div>
              {commands.length === 0 && (
                <p className="section-empty">Nothing runs in a plot yet.</p>
              )}
              {commands.map((command, index) => (
                <div className="recipe-row command" key={index}>
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
                  <label
                    className="recipe-command-routing"
                    title="Publish the stable wildcard-compatible HTTPS address through portless"
                  >
                    <input
                      type="checkbox"
                      checked={
                        command.url === true && command.portless !== false
                      }
                      onChange={(event) =>
                        setCommands(
                          commands.map((entry, at) =>
                            at === index
                              ? {
                                  ...entry,
                                  ...(event.target.checked
                                    ? { url: true }
                                    : {}),
                                  portless: event.target.checked,
                                }
                              : entry,
                          ),
                        )
                      }
                    />
                    Named HTTPS URL
                  </label>
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
                Serving commands get a named HTTPS URL by default. Disable it to
                keep only the stable localhost port. Named routing needs
                portless and its one-time HTTPS proxy setup.
              </p>
            </section>

            <section className="recipe-part">
              <div className="recipe-part-title">
                <h3>Attached services</h3>
                <p>
                  Provider resources shown together in every Plot's sidebar.
                </p>
                <div className="recipe-actions">
                  <AddMenu
                    label="Add service"
                    open={adding === "resources"}
                    onOpen={() =>
                      setAdding(
                        adding === "resources" ? undefined : "resources",
                      )
                    }
                    onClose={() => setAdding(undefined)}
                    suggestions={[]}
                    onPick={() => undefined}
                    blanks={resourceProviders.map((provider) => ({
                      id: `provider-${provider}`,
                      label: providerName(provider),
                      detail: resourceDescription(provider),
                      icon:
                        provider === "convex" ? (
                          <ConvexMark size={12} />
                        ) : (
                          <Sparkles size={12} />
                        ),
                      add: () => {
                        const id = uniqueResourceId(provider, resources);
                        setResources([
                          ...resources,
                          { id, ...resourceDefaults(provider) },
                        ]);
                      },
                    }))}
                  />
                </div>
              </div>
              {resources.length === 0 && (
                <p className="section-empty">
                  Runtime commands and discovered deployments still appear
                  automatically. Add services here when their relationship is
                  otherwise invisible.
                </p>
              )}
              {resources.map((resource, index) => (
                <div className="recipe-resource" key={index}>
                  <div className="recipe-resource-head">
                    <input
                      className="recipe-id mono"
                      value={resource.id}
                      aria-label="Resource id"
                      onChange={(event) =>
                        setResources(
                          resources.map((entry, at) =>
                            at === index
                              ? { ...entry, id: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                    <select
                      value={resource.provider}
                      aria-label="Provider"
                      onChange={(event) => {
                        const provider = event.target
                          .value as PlotResourceProvider;
                        setResources(
                          resources.map((entry, at) =>
                            at === index
                              ? {
                                  ...entry,
                                  ...resourceDefaults(provider),
                                }
                              : entry,
                          ),
                        );
                      }}
                    >
                      {resourceProviders.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerName(provider)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={resource.isolation}
                      aria-label="Isolation"
                      onChange={(event) =>
                        setResources(
                          resources.map((entry, at) =>
                            at === index
                              ? {
                                  ...entry,
                                  isolation: event.target.value as
                                    | "isolated"
                                    | "namespaced"
                                    | "shared"
                                    | "manual",
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="isolated">Isolated</option>
                      <option value="namespaced">Namespaced</option>
                      <option value="shared">Shared</option>
                      <option value="manual">Manual</option>
                    </select>
                    <button
                      type="button"
                      aria-label="Remove resource"
                      onClick={() =>
                        setResources(resources.filter((_, at) => at !== index))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div className="recipe-resource-fields">
                    <label>
                      <span className="micro">Runtime command</span>
                      <select
                        value={resource.command ?? ""}
                        onChange={(event) =>
                          setResources(
                            resources.map((entry, at) =>
                              at === index
                                ? {
                                    ...entry,
                                    command: event.target.value || undefined,
                                  }
                                : entry,
                            ),
                          )
                        }
                      >
                        <option value="">No local command</option>
                        {commands
                          .filter((command) => command.id)
                          .map((command) => (
                            <option key={command.id} value={command.id}>
                              {command.id}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      <span className="micro">Dashboard URL</span>
                      <input
                        className="mono"
                        value={resource.dashboardUrl ?? ""}
                        placeholder="https://…"
                        onChange={(event) =>
                          setResources(
                            resources.map((entry, at) =>
                              at === index
                                ? {
                                    ...entry,
                                    dashboardUrl:
                                      event.target.value || undefined,
                                  }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
              <p className="recipe-hint">
                Isolated resources belong to one Plot. Namespaced and shared
                resources stay honest about provider limits; manual means Silvic
                can display and link them but cannot configure them.
              </p>
            </section>
          </div>
          <aside className="recipe-preview">
            <p className="micro">Next plot</p>
            <label className="preview-branch">
              <span className="micro">Branch</span>
              <input
                className="mono"
                value={sampleBranch}
                onChange={(event) => setSampleBranch(event.target.value)}
              />
            </label>
            {preview ? (
              <>
                <div className="field">
                  <span className="field-label">Name</span>
                  <i className="field-leader" />
                  <span className="field-value mono">{preview.name}</span>
                </div>
                <div className="field">
                  <span className="field-label">Address</span>
                  <i className="field-leader" />
                  <span className="field-value mono">{preview.url}</span>
                </div>
                <p className="preview-path mono">{preview.path}</p>
                {preview.advice && (
                  <p className="field-error">{preview.advice}</p>
                )}
              </>
            ) : (
              <p className="section-empty">…</p>
            )}
            <p className="micro preview-heading">Will run</p>
            {provision.length === 0 ? (
              <p className="section-empty">Nothing. The plot gets its files.</p>
            ) : (
              <ol className="preview-steps">
                {provision.map((step, index) => (
                  <li key={index}>
                    <span className="mono">{index + 1}</span>
                    {isConvexStep(step) ? (
                      <>
                        <ConvexMark size={11} />
                        {step.convex.name.replaceAll(
                          "{plot}",
                          preview?.name ?? "…",
                        )}
                      </>
                    ) : (
                      <>
                        <Terminal size={11} />
                        {step.label ?? step.run}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </aside>
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
            className="link-button"
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
const resourceProviders: readonly PlotResourceProvider[] = [
  "convex",
  "livekit",
  "stripe",
  "cloudflare",
  "vercel",
  "clerk",
  "workos",
  "github",
  "custom",
];

function resourceDefaults(
  provider: PlotResourceProvider,
): PlotResourceDefinition {
  switch (provider) {
    case "convex":
      return { provider, kind: "backend", isolation: "isolated" };
    case "livekit":
      return { provider, kind: "agent", isolation: "shared" };
    case "stripe":
      return { provider, kind: "payments", isolation: "namespaced" };
    case "cloudflare":
      return { provider, kind: "ingress", isolation: "namespaced" };
    case "vercel":
      return { provider, kind: "deployment", isolation: "isolated" };
    case "clerk":
    case "workos":
      return { provider, kind: "auth", isolation: "shared" };
    case "github":
      return { provider, kind: "review", isolation: "shared" };
    default:
      return { provider, kind: "service", isolation: "shared" };
  }
}

function providerName(provider: PlotResourceProvider): string {
  if (provider === "livekit") return "LiveKit Agent";
  if (provider === "workos") return "WorkOS";
  return `${provider[0]?.toUpperCase() ?? ""}${provider.slice(1)}`;
}

function resourceDescription(provider: PlotResourceProvider): string {
  const descriptions: Record<PlotResourceProvider, string> = {
    web: "A browser-facing runtime",
    convex: "An isolated backend deployment",
    livekit: "An agent or worker attached to the Plot",
    stripe: "Test payments and webhook forwarding",
    cloudflare: "A Worker, tunnel or public ingress",
    vercel: "A shareable Preview Deployment",
    clerk: "Authentication origin and instance",
    workos: "Authentication and callback configuration",
    github: "Issue, pull request and checks",
    custom: "Any external service Silvic should track",
  };
  return descriptions[provider];
}

function uniqueResourceId(
  provider: PlotResourceProvider,
  resources: readonly ResourceEntry[],
): string {
  const base = provider === "livekit" ? "agent" : provider;
  const taken = new Set(resources.map((resource) => resource.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Adding a step is a choice between things Silvic already knows belong here,
 * with a blank one at the end for what it could not guess. A repository that
 * runs npm and uses Convex should not be asked to type either.
 */
function AddMenu({
  label = "Add step",
  open,
  onOpen,
  onClose,
  suggestions,
  onPick,
  blanks,
}: {
  label?: string;
  open: boolean;
  onOpen(): void;
  onClose(): void;
  suggestions: readonly RecipeSuggestion[];
  onPick(suggestion: RecipeSuggestion): void;
  blanks: readonly {
    id: string;
    label: string;
    detail: string;
    icon: React.ReactNode;
    add(): void;
  }[];
}) {
  return (
    <div className="add-menu">
      <button type="button" className="add-trigger" onClick={onOpen}>
        <Plus size={12} /> {label}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={onClose} />
          <div className="menu add-choices">
            {suggestions.length > 0 && (
              <p className="micro">Suggested for this repository</p>
            )}
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                className="add-choice"
                onClick={() => {
                  onPick(suggestion);
                  onClose();
                }}
              >
                <span className="add-choice-icon">
                  {suggestion.step && "convex" in suggestion.step ? (
                    <ConvexMark size={12} />
                  ) : (
                    <Terminal size={12} />
                  )}
                </span>
                <span className="add-choice-body">
                  <strong>{suggestion.label}</strong>
                  <span className="mono truncate">{suggestion.detail}</span>
                </span>
              </button>
            ))}
            <p className="micro">Or start from nothing</p>
            {blanks.map((blank) => (
              <button
                key={blank.id}
                type="button"
                className="add-choice"
                onClick={() => {
                  blank.add();
                  onClose();
                }}
              >
                <span className="add-choice-icon">{blank.icon}</span>
                <span className="add-choice-body">
                  <strong>{blank.label}</strong>
                  <span className="truncate">{blank.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Whether a suggestion is already in the recipe, so it is not offered twice. */
function sameStep(step: ProvisionStep, suggestion: RecipeSuggestion): boolean {
  if (!suggestion.step) return false;
  if ("convex" in suggestion.step) return "convex" in step;
  return "run" in step && step.run === suggestion.step.run;
}

function StepTest({
  result,
}: {
  result: ProvisionResult | "running" | undefined;
}) {
  if (!result) return null;
  if (result === "running") {
    return <p className="recipe-hint">Running in the primary checkout…</p>;
  }
  return (
    <div className="step-test" data-failed={result.exitCode !== 0 || undefined}>
      <span className="mono">
        {result.exitCode === 0
          ? `ok · ${Math.round(result.durationMs / 100) / 10}s`
          : `exit ${result.exitCode}`}
      </span>
      {result.output && <pre className="mono">{result.output.slice(-600)}</pre>}
    </div>
  );
}

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
    provision.push({
      label: "Install dependencies",
      run: `${manager} install`,
    });
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
