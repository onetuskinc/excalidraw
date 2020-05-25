import React from "react";
import ReactDOM from "react-dom";

import { EVENT } from "./constants";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { IsMobileProvider } from "./is-mobile";
import App from "./components/App";
import { register as registerServiceWorker } from "./serviceWorker";

import "./css/styles.scss";

// Block pinch-zooming on iOS outside of the content area
// document.addEventListener(
//   "touchmove",
//   (event) => {
//     // @ts-ignore
//     if (event.scale !== 1) {
//       event.preventDefault();
//     }
//   },
//   { passive: false },
// );

export default ({ rootElement }: { rootElement: HTMLElement }) => {
  ReactDOM.render(
    <TopErrorBoundary>
      <IsMobileProvider>
        <App />
      </IsMobileProvider>
    </TopErrorBoundary>,
    rootElement,
  );

  registerServiceWorker({
    onUpdate: (registration) => {
      const waitingServiceWorker = registration.waiting;
      if (waitingServiceWorker) {
        waitingServiceWorker.addEventListener(
          EVENT.STATE_CHANGE,
          (event: Event) => {
            const target = event.target as ServiceWorker;
            const state = target.state as ServiceWorkerState;
            if (state === "activated") {
              window.location.reload();
            }
          },
        );
        waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
      }
    },
  });
};
