import React from "react";
import { showSelectedShapeActions } from "../element";
import { calculateScrollCenter } from "../scene";
import { exportCanvas } from "../data";

import { AppState } from "../types";
import { NonDeletedExcalidrawElement } from "../element/types";

import { ActionManager } from "../actions/manager";
import { Island } from "./Island";
import Stack from "./Stack";
import { FixedSideContainer } from "./FixedSideContainer";
import { LockIcon } from "./LockIcon";
import { ExportDialog, ExportCB } from "./ExportDialog";
import { t } from "../i18n";
import { HintViewer } from "./HintViewer";
import useIsMobile from "../is-mobile";

import { ExportType } from "../scene/types";
import { MobileMenu } from "./MobileMenu";
import { ZoomActions, SelectedShapeActions, ShapesSwitcher } from "./Actions";
import { Section } from "./Section";
import { ErrorDialog } from "./ErrorDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { LoadingMessage } from "./LoadingMessage";
import { CLASSES } from "../constants";

import "./LayerUI.scss";

interface LayerUIProps {
  actionManager: ActionManager;
  appState: AppState;
  canvas: HTMLCanvasElement | null;
  setAppState: any;
  elements: readonly NonDeletedExcalidrawElement[];
  onUsernameChange: (username: string) => void;
  onLockToggle: () => void;
  zenModeEnabled: boolean;
  toggleZenMode: () => void;
}

const LayerUI = ({
  actionManager,
  appState,
  setAppState,
  canvas,
  elements,
  onUsernameChange,
  onLockToggle,
  zenModeEnabled,
  toggleZenMode,
}: LayerUIProps) => {
  const isMobile = useIsMobile();

  const renderExportDialog = () => {
    const createExporter = (type: ExportType): ExportCB => (
      exportedElements,
      scale,
    ) => {
      if (canvas) {
        exportCanvas(type, exportedElements, appState, canvas, {
          exportBackground: appState.exportBackground,
          name: appState.name,
          viewBackgroundColor: appState.viewBackgroundColor,
          scale,
          shouldAddWatermark: appState.shouldAddWatermark,
        });
      }
    };
    return (
      <ExportDialog
        elements={elements}
        appState={appState}
        actionManager={actionManager}
        onExportToPng={createExporter("png")}
        onExportToSvg={createExporter("svg")}
        onExportToClipboard={createExporter("clipboard")}
        onExportToBackend={(exportedElements) => {
          if (canvas) {
            exportCanvas(
              "backend",
              exportedElements,
              {
                ...appState,
                selectedElementIds: {},
              },
              canvas,
              appState,
            );
          }
        }}
      />
    );
  };

  const renderCanvasActions = () => (
    <Section
      heading="canvasActions"
      className={`zen-mode-transition ${zenModeEnabled && "transition-left"}`}
    >
      {/* the zIndex ensures this menu has higher stacking order,
         see https://github.com/excalidraw/excalidraw/pull/1445 */}
      <Island padding={4} style={{ zIndex: 1 }}>
        <Stack.Col gap={4}>
          <Stack.Row gap={1} justifyContent="space-between">
            {actionManager.renderAction("clearCanvas")}
            {actionManager.renderAction("changeViewBackgroundColor")}
          </Stack.Row>
        </Stack.Col>
      </Island>
    </Section>
  );

  const renderSelectedShapeActions = () => (
    <Section
      heading="selectedShapeActions"
      className={`zen-mode-transition ${zenModeEnabled && "transition-left"}`}
    >
      <Island className={CLASSES.SHAPE_ACTIONS_MENU} padding={4}>
        <SelectedShapeActions
          appState={appState}
          elements={elements}
          renderAction={actionManager.renderAction}
          elementType={appState.elementType}
        />
      </Island>
    </Section>
  );

  const renderFixedSideContainer = () => {
    const shouldRenderSelectedShapeActions = showSelectedShapeActions(
      appState,
      elements,
    );
    return (
      <FixedSideContainer side="top">
        <HintViewer appState={appState} elements={elements} />
        <div className="App-menu App-menu_top">
          <Stack.Col
            gap={4}
            className={zenModeEnabled && "disable-pointerEvents"}
          >
            {renderCanvasActions()}
            {shouldRenderSelectedShapeActions && renderSelectedShapeActions()}
          </Stack.Col>
          <Section heading="shapes">
            {(heading) => (
              <Stack.Col gap={4} align="start">
                <Stack.Row gap={1}>
                  <Island padding={1} className={zenModeEnabled && "zen-mode"}>
                    {heading}
                    <Stack.Row gap={1}>
                      <ShapesSwitcher
                        elementType={appState.elementType}
                        setAppState={setAppState}
                      />
                    </Stack.Row>
                  </Island>
                  <LockIcon
                    zenModeEnabled={zenModeEnabled}
                    checked={appState.elementLocked}
                    onChange={onLockToggle}
                    title={t("toolBar.lock")}
                  />
                </Stack.Row>
              </Stack.Col>
            )}
          </Section>
          <div />
        </div>
        {
          <div
            className={`App-menu App-menu_bottom zen-mode-transition ${
              zenModeEnabled && "App-menu_bottom--transition-left"
            }`}
          >
            <Stack.Col gap={2}>
              <Section heading="canvasActions">
                <Island padding={1}>
                  <ZoomActions
                    renderAction={actionManager.renderAction}
                    zoom={appState.zoom}
                  />
                </Island>
              </Section>
            </Stack.Col>
          </div>
        }
      </FixedSideContainer>
    );
  };

  const renderFooter = () => (
    <footer role="contentinfo" className="layer-ui__wrapper__footer">
      <button
        className={`disable-zen-mode ${
          zenModeEnabled && "disable-zen-mode--visible"
        }`}
        onClick={toggleZenMode}
      >
        {t("buttons.exitZenMode")}
      </button>
      {appState.scrolledOutside && (
        <button
          className="scroll-back-to-content"
          onClick={() => {
            setAppState({ ...calculateScrollCenter(elements) });
          }}
        >
          {t("buttons.scrollBackToContent")}
        </button>
      )}
    </footer>
  );

  return isMobile ? (
    <MobileMenu
      appState={appState}
      elements={elements}
      actionManager={actionManager}
      exportButton={renderExportDialog()}
      setAppState={setAppState}
      onUsernameChange={onUsernameChange}
      onLockToggle={onLockToggle}
    />
  ) : (
    <div className="layer-ui__wrapper">
      {appState.isLoading && <LoadingMessage />}
      {appState.errorMessage && (
        <ErrorDialog
          message={appState.errorMessage}
          onClose={() => setAppState({ errorMessage: null })}
        />
      )}
      {appState.showShortcutsDialog && (
        <ShortcutsDialog
          onClose={() => setAppState({ showShortcutsDialog: null })}
        />
      )}
      {renderFixedSideContainer()}
      {renderFooter()}
    </div>
  );
};

const areEqual = (prev: LayerUIProps, next: LayerUIProps) => {
  const getNecessaryObj = (appState: AppState): Partial<AppState> => {
    const {
      draggingElement,
      resizingElement,
      multiElement,
      editingElement,
      isResizing,
      cursorX,
      cursorY,
      ...ret
    } = appState;
    return ret;
  };
  const prevAppState = getNecessaryObj(prev.appState);
  const nextAppState = getNecessaryObj(next.appState);

  const keys = Object.keys(prevAppState) as (keyof Partial<AppState>)[];

  return (
    prev.elements === next.elements &&
    keys.every((key) => prevAppState[key] === nextAppState[key])
  );
};

export default React.memo(LayerUI, areEqual);
