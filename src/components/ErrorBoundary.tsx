'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || 'Unexpected interface exception',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[JARVIS-X UI ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#04070F] p-6 text-slate-100">
          <div className="glass-panel max-w-md p-6 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-amber-400/30 bg-amber-500/10 text-amber-300">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h2 className="font-display text-lg font-semibold tracking-wide text-slate-100">
              Interface Subsystem Fault Isolated
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              JARVIS-X contained a rendering error so core state remains intact:{' '}
              <span className="font-mono text-xs text-amber-300">{this.state.errorMessage}</span>
            </p>
            <button
              type="button"
              onClick={this.handleReset}
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/25"
            >
              <RotateCcw className="h-4 w-4" />
              Restore Console View
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
