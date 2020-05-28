import React from "react";
import ReactDOM from "react-dom";

import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { IsMobileProvider } from "./is-mobile";
import { WindowProvider } from "./window";
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

  const win = rootElement.ownerDocument?.defaultView || window;
  if (!rootElement.ownerDocument?.defaultView) {
    console.warn("ExcaliDraw is falling back to the global window object");
  }

  // Block pinch-zooming on iOS outside of the content area

  ReactDOM.render(
    <TopErrorBoundary>
      <WindowProvider window={win}>
        <IsMobileProvider window={win}>
          <App
            receiveData={events}
            sendData={sendData}
            username={username}
            socketId={socketId}
            window={win}
          />
        </IsMobileProvider>
      </WindowProvider>
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
