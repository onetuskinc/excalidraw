import React, { useState, useContext } from "react";

const context = React.createContext(document.body.ownerDocument?.defaultView);

export const WindowProvider = ({
  children,
  window,
}: {
  children: React.ReactNode;
  window: Window;
}) => {
  const [windowObject] = useState(window);
  return <context.Provider value={windowObject}>{children}</context.Provider>;
};

export default function useGetWindow() {
  return useContext(context) || window;
}
