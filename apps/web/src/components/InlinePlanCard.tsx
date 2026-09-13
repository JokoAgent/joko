import { useState } from "react";
import type { JSX } from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, ListTodo } from "lucide-react";
import type { TimelinePlanView } from "../model.js";
import type { Translator } from "./types.js";
import { cx } from "./ui.js";

/** Primary in-timeline plan presentation. */
export function InlinePlanCard({ plan, animated, t }: {
  readonly plan: TimelinePlanView;
  readonly animated: boolean;
  readonly t: Translator;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  if (plan.steps.length === 0) return null;

  const completed = plan.steps.filter((step) => step.state === "completed").length;
  const total = plan.steps.length;
  const active = plan.steps.find((step) => step.state === "inProgress");
  const summary = active?.content ?? plan.steps.at(-1)?.content ?? "";

  return (
    <div className="inline-plan" data-inline-plan-card="true" data-inline-plan-key={plan.identity}>
      <div className="inline-plan__surface">
        <button
          type="button"
          className="inline-plan__summary"
          aria-expanded={expanded}
          aria-label={t("planPill.title")}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <ListTodo className="inline-plan__list-icon" aria-hidden="true" />
          <span className="inline-plan__count">{completed}/{total}</span>
          <span className="inline-plan__separator" aria-hidden="true">·</span>
          <span className="inline-plan__active-summary">{summary}</span>
        </button>

        {!expanded && <div className="inline-plan__progress" aria-hidden="true"><span style={{ width: `${(completed / total) * 100}%` }} /></div>}

        {expanded && (
          <div className="inline-plan__steps">
            {plan.steps.map((step) => (
              <div className={cx("inline-plan__step", `is-${step.state}`)} key={step.id}>
                {step.state === "completed" && <CircleCheck aria-hidden="true" />}
                {step.state === "inProgress" && (
                  <span className={cx("inline-plan__step-icon", animated && "session-status-breathing")} data-inline-plan-step-active="true" data-inline-plan-step-breathing={animated ? "true" : "false"}>
                    <CircleDot aria-hidden="true" />
                  </span>
                )}
                {step.state === "pending" && <Circle aria-hidden="true" />}
                <span>{step.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
