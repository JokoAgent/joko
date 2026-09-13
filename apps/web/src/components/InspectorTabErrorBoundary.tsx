import { Component } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import type { Translator } from "./types.js";
import { Button } from "./ui.js";

interface InspectorTabErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly t: Translator;
}

interface InspectorTabErrorBoundaryState {
  readonly failed: boolean;
  readonly retryKey: number;
}

/** Keeps a single capability panel failure from replacing the task workspace. */
export class InspectorTabErrorBoundary extends Component<InspectorTabErrorBoundaryProps, InspectorTabErrorBoundaryState> {
  override state: InspectorTabErrorBoundaryState = { failed: false, retryKey: 0 };

  static getDerivedStateFromError(_error: unknown): Partial<InspectorTabErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidUpdate(previous: InspectorTabErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState((state) => ({ failed: false, retryKey: state.retryKey + 1 }));
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return <div key={this.state.retryKey} className="inspector-tab-error-boundary__content">{this.props.children}</div>;
    return <div className="inspector-empty inspector-tab-error-boundary" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h2>{this.props.t("errorBoundary.routeTitle")}</h2>
      <p>{this.props.t("errorBoundary.body")}</p>
      <Button tone="primary" onClick={() => this.setState((state) => ({ failed: false, retryKey: state.retryKey + 1 }))}><RefreshCcw aria-hidden="true" />{this.props.t("common.retry")}</Button>
    </div>;
  }
}
