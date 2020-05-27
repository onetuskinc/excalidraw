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
  username,
  socketId,
}: {
  rootElement: HTMLElement;
  sendData: Function;
  username: string;
  socketId: string;
}) => {
  const events = new EventEmitter();

  // Block pinch-zooming on iOS outside of the content area

  ReactDOM.render(
    <TopErrorBoundary>
      <IsMobileProvider>
        <App
          receiveData={events}
          sendData={sendData}
          username={username}
          socketId={socketId}
        />
      </IsMobileProvider>
    </TopErrorBoundary>,
    rootElement,
  );

  return {
    send(...args: any[]) {
      events.emit("data", ...args);
    },
    mouse(...args: any[]) {
      events.emit("mouse", ...args);
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
