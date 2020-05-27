import React from "react";
import ReactDOM from "react-dom";

import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { IsMobileProvider } from "./is-mobile";
import App from "./components/App";

import "./css/styles.scss";

import { EventEmitter } from "events";
import { globalSceneState } from "./scene";

export default ({
  rootElement,
  sendData,
}: {
  rootElement: HTMLElement;
  sendData: Function;
}) => {
  const events = new EventEmitter();

  // Block pinch-zooming on iOS outside of the content area

  ReactDOM.render(
    <TopErrorBoundary>
      <IsMobileProvider>
        <App receiveData={events} sendData={sendData} />
      </IsMobileProvider>
    </TopErrorBoundary>,
    rootElement,
  );

  return {
    send(...args: any[]) {
      events.emit("data", ...args);
    },
    resize() {
      events.emit("resize");
    },
    destroy() {
      events.removeAllListeners();
      globalSceneState.replaceAllElements([]);
      ReactDOM.unmountComponentAtNode(rootElement);
    },
  };
};
