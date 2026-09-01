import { Component } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ListTodo, RefreshCcw, Settings } from "lucide-react";
import { translate } from "../i18n.js";
import type { Locale } from "../model.js";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly scope: "app" | "route";
  readonly resetKey?: string;
  readonly resetAfterNavigation?: boolean;
  readonly onBackToTasks?: () => void;
  readonly onOpenSettings?: () => void;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

/** React render/lifecycle boundary only; asynchronous operation failures stay with runAction. */
export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(_error: unknown): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const locale = currentLocale();
    const navigate = (action: (() => void) | undefined): void => {
      action?.();
      if (this.props.resetAfterNavigation) this.setState({ failed: false });
    };
    return (
      <section className={`error-boundary error-boundary--${this.props.scope}`} role="alert" data-error-boundary-scope={this.props.scope}>
        <div className="error-boundary__icon" aria-hidden="true"><AlertTriangle /></div>
        <div className="error-boundary__copy">
          <p className="eyebrow">Joko</p>
          <h1>{translate(locale, this.props.scope === "app" ? "errorBoundary.appTitle" : "errorBoundary.routeTitle")}</h1>
          <p>{translate(locale, "errorBoundary.body")}</p>
        </div>
        <div className="error-boundary__actions">
          <button type="button" className="error-boundary__action error-boundary__action--primary" onClick={() => window.location.reload()}><RefreshCcw aria-hidden="true" />{translate(locale, "errorBoundary.reload")}</button>
          {this.props.onBackToTasks !== undefined && <button type="button" className="error-boundary__action" onClick={() => navigate(this.props.onBackToTasks)}><ListTodo aria-hidden="true" />{translate(locale, "errorBoundary.tasks")}</button>}
          {this.props.onOpenSettings !== undefined && <button type="button" className="error-boundary__action" onClick={() => navigate(this.props.onOpenSettings)}><Settings aria-hidden="true" />{translate(locale, "errorBoundary.settings")}</button>}
        </div>
      </section>
    );
  }
}

export function routeErrorBoundaryKey(kind: string, sessionId?: string): string {
  return `${kind}:${sessionId ?? ""}`;
}

function currentLocale(): Locale {
  if (typeof document === "undefined") return "en";
  if (document.documentElement.lang === "zh-CN") return "zh-CN";
  if (document.documentElement.lang === "en-XA") return "en-XA";
  return "en";
}
