declare global {
  namespace App {
    interface Locals {
      user: {
        id: string;
        email: string;
        name: string;
      } | null;
      session: {
        id: string;
        userId: string;
        expiresAt: Date;
      } | null;
    }
    // FRI-172 (AC13): the shallow-routed open-memory id. `pushState(url, {
    // memoryId })` carries the accordion-open entry on warm transitions; cold
    // loads fall back to `$page.params.id` (page.state is empty across a full
    // document load).
    interface PageState {
      memoryId?: string;
    }
  }
}

export {};
