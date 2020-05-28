import React from "react";
import { AppState } from "../types";
import { ActionManager } from "../actions/manager";
import { t } from "../i18n";
import Stack from "./Stack";
import { showSelectedShapeActions } from "../element";
import { NonDeletedExcalidrawElement } from "../element/types";
import { FixedSideContainer } from "./FixedSideContainer";
import { Island } from "./Island";
import { HintViewer } from "./HintViewer";
import { calculateScrollCenter } from "../scene";
import { SelectedShapeActions, ShapesSwitcher } from "./Actions";
import { Section } from "./Section";
import { SCROLLBAR_WIDTH, SCROLLBAR_MARGIN } from "../scene/scrollbars";
import { LockIcon } from "./LockIcon";
import { LoadingMessage } from "./LoadingMessage";

type MobileMenuProps = {
  appState: AppState;
  actionManager: ActionManager;
  exportButton: React.ReactNode;
  setAppState: any;
  elements: readonly NonDeletedExcalidrawElement[];
  onUsernameChange: (username: string) => void;
  onLockToggle: () => void;
  canvas: HTMLCanvasElement | null;
};

export const MobileMenu = ({
  appState,
  elements,
  actionManager,
  exportButton,
  setAppState,
  onUsernameChange,
  onLockToggle,
  canvas,
}: MobileMenuProps) => (
  <>
    {appState.isLoading && <LoadingMessage />}
    <FixedSideContainer side="top">
      <Section heading="shapes">
        {(heading) => (
          <Stack.Col gap={4} align="center">
            <Stack.Row gap={1}>
              <Island padding={1}>
                {heading}
                <Stack.Row gap={1}>
                  <ShapesSwitcher
                    elementType={appState.elementType}
                    setAppState={setAppState}
                  />
                </Stack.Row>
              </Island>
              <LockIcon
                checked={appState.elementLocked}
                onChange={onLockToggle}
                title={t("toolBar.lock")}
              />
            </Stack.Row>
          </Stack.Col>
        )}
      </Section>
      <HintViewer appState={appState} elements={elements} />
    </FixedSideContainer>
    <div
      className="App-bottom-bar"
      style={{
        marginBottom: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
        marginLeft: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
        marginRight: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
      }}
    >
      <Island padding={3}>
        {appState.openMenu === "canvas" ? (
          <Section className="App-mobile-menu" heading="canvasActions">
            <div className="panelColumn">
              <Stack.Col gap={4}>
                {actionManager.renderAction("clearCanvas")}
                {actionManager.renderAction("changeViewBackgroundColor")}
              </Stack.Col>
            </div>
          </Section>
        ) : appState.openMenu === "shape" &&
          showSelectedShapeActions(appState, elements) ? (
          <Section className="App-mobile-menu" heading="selectedShapeActions">
            <SelectedShapeActions
              appState={appState}
              elements={elements}
              renderAction={actionManager.renderAction}
              elementType={appState.elementType}
            />
          </Section>
        ) : null}
        <footer className="App-toolbar">
          <div className="App-toolbar-content">
            {actionManager.renderAction("toggleCanvasMenu")}
            {actionManager.renderAction("toggleEditMenu")}
            {actionManager.renderAction("undo")}
            {actionManager.renderAction("redo")}
            {actionManager.renderAction(
              appState.multiElement ? "finalize" : "duplicateSelection",
            )}
            {actionManager.renderAction("deleteSelectedElements")}
          </div>
          {appState.scrolledOutside && (
            <button
              className="scroll-back-to-content"
              onClick={() => {
                if (canvas === null) {
                  return;
                }
                setAppState({ ...calculateScrollCenter(elements, canvas) });
              }}
            >
              {t("buttons.scrollBackToContent")}
            </button>
          )}
        </footer>
      </Island>
    </div>
  </>
);
