import React from "react";
import ReactDOM from "react-dom";

import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { IsMobileProvider } from "./is-mobile";
import App from "./components/App";

import "./css/styles.scss";

export default ({ rootElement }: { rootElement: HTMLElement }) => {
  // Block pinch-zooming on iOS outside of the content area
  document.addEventListener(
    "touchmove",
    (event) => {
      // @ts-ignore
      if (event.scale !== 1) {
        event.preventDefault();
      }
    },
    { passive: false },
  );

  ReactDOM.render(
    <TopErrorBoundary>
      <IsMobileProvider>
        <App />
      </IsMobileProvider>
    </TopErrorBoundary>,
    rootElement,
  );
};
