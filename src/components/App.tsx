import React from "react";

import rough from "roughjs/bin/rough";
import { RoughCanvas } from "roughjs/bin/canvas";
import { simplify, Point } from "points-on-curve";
import { FlooredNumber } from "../types";

import {
  newElement,
  newTextElement,
  duplicateElement,
  resizeTest,
  isInvisiblySmallElement,
  isTextElement,
  textWysiwyg,
  getCommonBounds,
  getCursorForResizingElement,
  getPerfectElementSize,
  normalizeDimensions,
  getElementMap,
  getDrawingVersion,
  getSyncableElements,
  newLinearElement,
  resizeElements,
  getElementWithResizeHandler,
  canResizeMutlipleElements,
  getResizeOffsetXY,
  getResizeArrowDirection,
  getResizeHandlerFromCoords,
  isNonDeletedElement,
} from "../element";
import {
  deleteSelectedElements,
  getElementsWithinSelection,
  isOverScrollBars,
  getElementAtPosition,
  getElementContainingPosition,
  getNormalizedZoom,
  getSelectedElements,
  globalSceneState,
  isSomeElementSelected,
  calculateScrollCenter,
} from "../scene";
import { SocketUpdateDataSource, exportCanvas } from "../data";

import { renderScene } from "../renderer";
import { AppState, GestureEvent, Gesture } from "../types";
import { ExcalidrawElement, ExcalidrawTextElement } from "../element/types";

import { distance2d, isPathALoop } from "../math";

import {
  isWritableElement,
  isInputLike,
  isToolIcon,
  debounce,
  distance,
  viewportCoordsToSceneCoords,
  sceneCoordsToViewportCoords,
  getCursorForShape,
} from "../utils";
import {
  KEYS,
  isArrowKey,
  getResizeCenterPointKey,
  getResizeWithSidesSameLengthKey,
} from "../keys";

import { findShapeByKey, shapesShortcutKeys } from "../shapes";
import { createHistory, SceneHistory } from "../history";

import ContextMenu from "./ContextMenu";

import { ActionManager } from "../actions/manager";
import "../actions";
import { actions } from "../actions/register";

import { ActionResult } from "../actions/types";
import { getDefaultAppState } from "../appState";
import { t, getLanguage } from "../i18n";

import {
  copyToAppClipboard,
  getClipboardContent,
  probablySupportsClipboardBlob,
  probablySupportsClipboardWriteText,
} from "../clipboard";
import { normalizeScroll } from "../scene";
import { getCenter, getDistance } from "../gesture";
import { createUndoAction, createRedoAction } from "../actions/actionHistory";

import {
  CURSOR_TYPE,
  ELEMENT_SHIFT_TRANSLATE_AMOUNT,
  ELEMENT_TRANSLATE_AMOUNT,
  POINTER_BUTTON,
  DRAGGING_THRESHOLD,
  TEXT_TO_CENTER_SNAP_THRESHOLD,
  LINE_CONFIRM_THRESHOLD,
  SCENE,
  EVENT,
  ENV,
} from "../constants";
import { TAP_TWICE_TIMEOUT } from "../time_constants";

import LayerUI from "./LayerUI";
import { ScrollBars, SceneState } from "../scene/types";
import { mutateElement, newElementWith } from "../element/mutateElement";
import { invalidateShapeForElement } from "../renderer/renderElement";
import { unstable_batchedUpdates } from "react-dom";
import { SceneStateCallbackRemover } from "../scene/globalScene";
import { isLinearElement } from "../element/typeChecks";
import { actionFinalize } from "../actions";

import throttle from "lodash.throttle";
import {
  getSelectedGroupIds,
  selectGroupsForSelectedElements,
  isElementInGroup,
  getSelectedGroupIdForElement,
} from "../groups";

/**
 * @param func handler taking at most single parameter (event).
 */
const withBatchedUpdates = <
  TFunction extends ((event: any) => void) | (() => void)
>(
  func: Parameters<TFunction>["length"] extends 0 | 1 ? TFunction : never,
) =>
  ((event) => {
    unstable_batchedUpdates(func as TFunction, event);
  }) as TFunction;

const { history } = createHistory();

let didTapTwice: boolean = false;
let tappedTwiceTimer = 0;
let cursorX = 0;
let cursorY = 0;
let isHoldingSpace: boolean = false;
let isPanning: boolean = false;
let isDraggingScrollBar: boolean = false;
let currentScrollBars: ScrollBars = { horizontal: null, vertical: null };

let lastPointerUp: ((event: any) => void) | null = null;
const gesture: Gesture = {
  pointers: new Map(),
  lastCenter: null,
  initialDistance: null,
  initialScale: null,
};

const SYNC_FULL_SCENE_INTERVAL_MS = 20000;

class App extends React.Component<any, AppState> {
  canvas: HTMLCanvasElement | null = null;
  rc: RoughCanvas | null = null;
  lastBroadcastedOrReceivedSceneVersion: number = -1;
  broadcastedElementVersions: Map<string, number> = new Map();
  removeSceneCallback: SceneStateCallbackRemover | null = null;
  sendData: Function;
  actionManager: ActionManager;
  canvasOnlyActions = ["selectAll"];

  public state: AppState = {
    canvasWidth: 800,
    canvasHeight: 600,
    ...getDefaultAppState(),
    isLoading: true,
  };

  constructor(props: any) {
    super(props);

    {
      const updateScene = (
        decryptedData: SocketUpdateDataSource[SCENE.INIT | SCENE.UPDATE],
        { scrollToContent = false }: { scrollToContent?: boolean } = {},
      ) => {
        const { elements: remoteElements } = decryptedData.payload;

        if (scrollToContent && this.canvas) {
          this.setState({
            ...this.state,
            ...calculateScrollCenter(
              remoteElements.filter((element: { isDeleted: boolean }) => {
                return !element.isDeleted;
              }),
              this.canvas,
            ),
          });
        }

        // Perform reconciliation - in collaboration, if we encounter
        // elements with more staler versions than ours, ignore them
        // and keep ours.
        if (
          globalSceneState.getElementsIncludingDeleted() == null ||
          globalSceneState.getElementsIncludingDeleted().length === 0
        ) {
          globalSceneState.replaceAllElements(remoteElements);
        } else {
          // create a map of ids so we don't have to iterate
          // over the array more than once.
          const localElementMap = getElementMap(
            globalSceneState.getElementsIncludingDeleted(),
          );

          // Reconcile
          const newElements = remoteElements
            .reduce((elements, element) => {
              // if the remote element references one that's currently
              //  edited on local, skip it (it'll be added in the next
              //  step)
              if (
                element.id === this.state.editingElement?.id ||
                element.id === this.state.resizingElement?.id ||
                element.id === this.state.draggingElement?.id
              ) {
                return elements;
              }

              if (
                localElementMap.hasOwnProperty(element.id) &&
                localElementMap[element.id].version > element.version
              ) {
                elements.push(localElementMap[element.id]);
                delete localElementMap[element.id];
              } else if (
                localElementMap.hasOwnProperty(element.id) &&
                localElementMap[element.id].version === element.version &&
                localElementMap[element.id].versionNonce !==
                  element.versionNonce
              ) {
                // resolve conflicting edits deterministically by taking the one with the lowest versionNonce
                if (
                  localElementMap[element.id].versionNonce <
                  element.versionNonce
                ) {
                  elements.push(localElementMap[element.id]);
                } else {
                  // it should be highly unlikely that the two versionNonces are the same. if we are
                  // really worried about this, we can replace the versionNonce with the socket id.
                  elements.push(element);
                }
                delete localElementMap[element.id];
              } else {
                elements.push(element);
                delete localElementMap[element.id];
              }

              return elements;
            }, [] as Mutable<typeof remoteElements>)
            // add local elements that weren't deleted or on remote
            .concat(...Object.values(localElementMap));

          // Avoid broadcasting to the rest of the collaborators the scene
          // we just received!
          // Note: this needs to be set before replaceAllElements as it
          // syncronously calls render.
          this.lastBroadcastedOrReceivedSceneVersion = getDrawingVersion(
            newElements,
          );

          globalSceneState.replaceAllElements(newElements);
        }

        // We haven't yet implemented multiplayer undo functionality, so we clear the undo stack
        // when we receive any messages from another peer. This UX can be pretty rough -- if you
        // undo, a user makes a change, and then try to redo, your element(s) will be lost. However,
        // right now we think this is the right tradeoff.
        history.clear();
      };
      props.receiveData.on("data", (data: any) => {
        updateScene(data);
      });

      props.receiveData.on("mouse", (data: any) => {
        const {
          socketID,
          pointerCoords,
          button,
          username,
          selectedElementIds,
        } = data.payload;

        this.setState((state) => {
          if (!state.collaborators.has(socketID)) {
            state.collaborators.set(socketID, {});
          }
          const user = state.collaborators.get(socketID)!;
          user.pointer = pointerCoords;
          user.button = button;
          user.selectedElementIds = selectedElementIds;
          user.username = username;
          state.collaborators.set(socketID, user);
          return state;
        });
      });

      props.receiveData.on("resize", () => {
        this.onResize();
      });
    }

    this.sendData = props.sendData;

    this.actionManager = new ActionManager(
      this.syncActionResult,
      () => this.state,
      () => globalSceneState.getElementsIncludingDeleted(),
      this.props.window,
      () => this.canvas,
    );

    this.actionManager.registerAll(actions);

    this.actionManager.registerAction(createUndoAction(history));
    this.actionManager.registerAction(createRedoAction(history));
  }

  public render() {
    const { zenModeEnabled } = this.state;
    const canvasScale = this.props.window.devicePixelRatio;
    const canvasWidth = Number(this.state.canvasWidth) * canvasScale;
    const canvasHeight = Number(this.state.canvasHeight) * canvasScale;

    return (
      <div
        className="excalidraw-container"
        style={{ cursor: this.state.cursor.toString() }}
      >
        <LayerUI
          canvas={this.canvas}
          appState={this.state}
          setAppState={this.setAppState}
          actionManager={this.actionManager}
          elements={globalSceneState.getElements()}
          onUsernameChange={(username) => {
            this.setState({
              username,
            });
          }}
          onLockToggle={this.toggleLock}
          zenModeEnabled={zenModeEnabled}
          toggleZenMode={this.toggleZenMode}
          lng={getLanguage().lng}
        />
        <main>
          <canvas
            id="canvas"
            style={{
              width: "100%",
              height: "100%",
            }}
            width={canvasWidth}
            height={canvasHeight}
            ref={this.handleCanvasRef}
            onContextMenu={this.handleCanvasContextMenu}
            onPointerDown={this.handleCanvasPointerDown}
            onDoubleClick={this.handleCanvasDoubleClick}
            onPointerMove={this.handleCanvasPointerMove}
            onPointerUp={this.removePointer}
            onPointerCancel={this.removePointer}
          >
            {t("labels.drawingCanvas")}
          </canvas>
        </main>
      </div>
    );
  }

  private syncActionResult = withBatchedUpdates((res: ActionResult) => {
    if (this.unmounted) {
      return;
    }

    let editingElement: AppState["editingElement"] | null = null;
    if (res.elements) {
      res.elements.forEach((element) => {
        if (
          this.state.editingElement?.id === element.id &&
          this.state.editingElement !== element &&
          isNonDeletedElement(element)
        ) {
          editingElement = element;
        }
      });
      globalSceneState.replaceAllElements(res.elements);
      if (res.commitToHistory) {
        history.resumeRecording();
      }
    }

    if (res.appState || editingElement) {
      if (res.commitToHistory) {
        history.resumeRecording();
      }
      this.setState(
        (state) => ({
          ...res.appState,
          editingElement:
            editingElement || res.appState?.editingElement || null,
          isCollaborating: state.isCollaborating,
          collaborators: state.collaborators,
        }),
        () => {
          if (res.syncHistory) {
            history.setCurrentState(
              this.state,
              globalSceneState.getElementsIncludingDeleted(),
            );
          }
        },
      );
    }
  });

  // Lifecycle

  private onBlur = withBatchedUpdates(() => {
    isHoldingSpace = false;
  });

  private onUnload = () => {
    this.onBlur();
  };

  private disableEvent: EventHandlerNonNull = (event) => {
    event.preventDefault();
  };

  private onFontLoaded = () => {
    globalSceneState.getElementsIncludingDeleted().forEach((element) => {
      if (isTextElement(element)) {
        invalidateShapeForElement(element);
      }
    });
    this.onSceneUpdated();
  };

  private initializeScene = async () => {
    if (this.state.isLoading) {
      this.setState({ isLoading: false });
    }
  };

  private unmounted = false;

  public async componentDidMount() {
    if (
      process.env.NODE_ENV === "test" ||
      process.env.NODE_ENV === "development"
    ) {
      const setState = this.setState.bind(this);
      Object.defineProperties(this.props.window.h, {
        state: {
          configurable: true,
          get: () => {
            return this.state;
          },
        },
        setState: {
          configurable: true,
          value: (...args: Parameters<typeof setState>) => {
            return this.setState(...args);
          },
        },
        app: {
          configurable: true,
          value: this,
        },
      });
      this.onResize();
    }

    this.removeSceneCallback = globalSceneState.addCallback(
      this.onSceneUpdated,
    );

    const window = this.props.window;
    const document = window.document;

    document.addEventListener(EVENT.COPY, this.onCopy);
    document.addEventListener(EVENT.PASTE, this.pasteFromClipboard);
    document.addEventListener(EVENT.CUT, this.onCut);

    document.addEventListener(EVENT.KEYDOWN, this.onKeyDown, false);
    document.addEventListener(EVENT.KEYUP, this.onKeyUp, { passive: true });
    document.addEventListener(
      EVENT.MOUSE_MOVE,
      this.updateCurrentCursorPosition,
    );
    window.addEventListener(EVENT.RESIZE, this.onResize, false);
    window.addEventListener(EVENT.UNLOAD, this.onUnload, false);
    window.addEventListener(EVENT.BLUR, this.onBlur, false);
    window.addEventListener(EVENT.DRAG_OVER, this.disableEvent, false);
    window.addEventListener(EVENT.DROP, this.disableEvent, false);

    // rerender text elements on font load to fix #637 && #1553
    document.fonts?.addEventListener?.("loadingdone", this.onFontLoaded);

    // Safari-only desktop pinch zoom
    document.addEventListener(
      EVENT.GESTURE_START,
      this.onGestureStart as any,
      false,
    );
    document.addEventListener(
      EVENT.GESTURE_CHANGE,
      this.onGestureChange as any,
      false,
    );
    document.addEventListener(
      EVENT.GESTURE_END,
      this.onGestureEnd as any,
      false,
    );
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);

    this.initializeScene();
  }

  public componentWillUnmount() {
    this.unmounted = true;
    this.removeSceneCallback!();
    const window = this.props.window;
    const document = window.document;

    document.removeEventListener(EVENT.COPY, this.onCopy);
    document.removeEventListener(EVENT.PASTE, this.pasteFromClipboard);
    document.removeEventListener(EVENT.CUT, this.onCut);

    document.removeEventListener(EVENT.KEYDOWN, this.onKeyDown, false);
    document.removeEventListener(
      EVENT.MOUSE_MOVE,
      this.updateCurrentCursorPosition,
      false,
    );
    document.removeEventListener(EVENT.KEYUP, this.onKeyUp);
    window.removeEventListener(EVENT.RESIZE, this.onResize, false);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload, false);
    window.removeEventListener(EVENT.BLUR, this.onBlur, false);
    window.removeEventListener(EVENT.DRAG_OVER, this.disableEvent, false);
    window.removeEventListener(EVENT.DROP, this.disableEvent, false);

    document.removeEventListener(
      EVENT.GESTURE_START,
      this.onGestureStart as any,
      false,
    );
    document.removeEventListener(
      EVENT.GESTURE_CHANGE,
      this.onGestureChange as any,
      false,
    );
    document.removeEventListener(
      EVENT.GESTURE_END,
      this.onGestureEnd as any,
      false,
    );
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
  }
  private onResize = withBatchedUpdates(() => {
    const canvasWidth = this.canvas?.clientWidth || 800;
    const canvasHeight = this.canvas?.clientHeight || 600;

    globalSceneState
      .getElementsIncludingDeleted()
      .forEach((element) => invalidateShapeForElement(element));
    this.setState({
      canvasWidth,
      canvasHeight,
    });
  });

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    if (
      this.state.isCollaborating &&
      globalSceneState.getElements().length > 0
    ) {
      event.preventDefault();
      // NOTE: modern browsers no longer allow showing a custom message here
      event.returnValue = "";
    }
  });

  queueBroadcastAllElements = throttle(() => {
    this.broadcastScene(SCENE.UPDATE, /* syncAll */ true);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  componentDidUpdate() {
    const cursorButton: {
      [id: string]: string | undefined;
    } = {};
    const pointerViewportCoords: SceneState["remotePointerViewportCoords"] = {};
    const remoteSelectedElementIds: SceneState["remoteSelectedElementIds"] = {};
    const pointerUsernames: { [id: string]: string } = {};
    this.state.collaborators.forEach((user, socketID) => {
      if (user.selectedElementIds) {
        for (const id of Object.keys(user.selectedElementIds)) {
          if (!(id in remoteSelectedElementIds)) {
            remoteSelectedElementIds[id] = [];
          }
          remoteSelectedElementIds[id].push(socketID);
        }
      }
      if (!user.pointer) {
        return;
      }
      if (user.username) {
        pointerUsernames[socketID] = user.username;
      }
      pointerViewportCoords[socketID] = sceneCoordsToViewportCoords(
        {
          sceneX: user.pointer.x,
          sceneY: user.pointer.y,
        },
        this.state,
        this.canvas,
        this.props.window.devicePixelRatio,
      );
      cursorButton[socketID] = user.button;
    });
    const elements = globalSceneState.getElements();
    const { atLeastOneVisibleElement, scrollBars } = renderScene(
      elements.filter((element) => {
        // don't render text element that's being currently edited (it's
        //  rendered on remote only)
        return (
          !this.state.editingElement ||
          this.state.editingElement.type !== "text" ||
          element.id !== this.state.editingElement.id
        );
      }),
      this.state,
      this.state.selectionElement,
      this.props.window.devicePixelRatio,
      this.rc!,
      this.canvas!,
      {
        scrollX: this.state.scrollX,
        scrollY: this.state.scrollY,
        viewBackgroundColor: this.state.viewBackgroundColor,
        zoom: this.state.zoom,
        remotePointerViewportCoords: pointerViewportCoords,
        remotePointerButton: cursorButton,
        remoteSelectedElementIds: remoteSelectedElementIds,
        remotePointerUsernames: pointerUsernames,
        shouldCacheIgnoreZoom: this.state.shouldCacheIgnoreZoom,
      },
      {
        renderOptimizations: true,
      },
    );
    if (scrollBars) {
      currentScrollBars = scrollBars;
    }
    const scrolledOutside = !atLeastOneVisibleElement && elements.length > 0;
    if (this.state.scrolledOutside !== scrolledOutside) {
      this.setState({ scrolledOutside: scrolledOutside });
    }

    if (
      getDrawingVersion(globalSceneState.getElementsIncludingDeleted()) >
      this.lastBroadcastedOrReceivedSceneVersion
    ) {
      this.broadcastScene(SCENE.UPDATE, /* syncAll */ false);
      this.queueBroadcastAllElements();
    }

    history.record(this.state, globalSceneState.getElementsIncludingDeleted());
  }

  // Copy/paste

  private onCut = withBatchedUpdates((event: ClipboardEvent) => {
    if (isWritableElement(event.target)) {
      return;
    }
    this.copyAll();
    const { elements: nextElements, appState } = deleteSelectedElements(
      globalSceneState.getElementsIncludingDeleted(),
      this.state,
    );
    globalSceneState.replaceAllElements(nextElements);
    history.resumeRecording();
    this.setState({ ...appState });
    event.preventDefault();
  });

  private onCopy = withBatchedUpdates((event: ClipboardEvent) => {
    if (isWritableElement(event.target)) {
      return;
    }
    this.copyAll();
    event.preventDefault();
  });

  private copyAll = () => {
    copyToAppClipboard(globalSceneState.getElements(), this.state);
  };

  private copyToClipboardAsPng = () => {
    const elements = globalSceneState.getElements();

    const selectedElements = getSelectedElements(elements, this.state);
    exportCanvas(
      "clipboard",
      selectedElements.length ? selectedElements : elements,
      this.state,
      this.canvas!,
      this.state,
    );
  };

  private copyToClipboardAsSvg = () => {
    const selectedElements = getSelectedElements(
      globalSceneState.getElements(),
      this.state,
    );
    exportCanvas(
      "clipboard-svg",
      selectedElements.length
        ? selectedElements
        : globalSceneState.getElements(),
      this.state,
      this.canvas!,
      this.state,
    );
  };

  private resetTapTwice() {
    didTapTwice = false;
  }

  private onTapStart = (event: TouchEvent) => {
    if (!didTapTwice) {
      didTapTwice = true;
      clearTimeout(tappedTwiceTimer);
      tappedTwiceTimer = window.setTimeout(
        this.resetTapTwice,
        TAP_TWICE_TIMEOUT,
      );
      return;
    }
    // insert text only if we tapped twice with a single finger
    // event.touches.length === 1 will also prevent inserting text when user's zooming
    if (didTapTwice && event.touches.length === 1) {
      const [touch] = event.touches;
      // @ts-ignore
      this.handleCanvasDoubleClick({
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
      didTapTwice = false;
      clearTimeout(tappedTwiceTimer);
    }
    event.preventDefault();
  };

  private pasteFromClipboard = withBatchedUpdates(
    async (event: ClipboardEvent | null) => {
      // #686
      const target = this.props.window.document.activeElement;
      const elementUnderCursor = this.props.window.document.elementFromPoint(
        cursorX,
        cursorY,
      );
      if (
        // if no ClipboardEvent supplied, assume we're pasting via contextMenu
        //  thus these checks don't make sense
        event &&
        (!(elementUnderCursor instanceof HTMLCanvasElement) ||
          isWritableElement(target))
      ) {
        return;
      }
      const data = await getClipboardContent(event);
      if (data.elements) {
        this.addElementsFromPaste(data.elements);
      } else if (data.text) {
        this.addTextFromPaste(data.text);
      }
      this.selectShapeTool("selection");
      event?.preventDefault();
    },
  );

  private addElementsFromPaste = (
    clipboardElements: readonly ExcalidrawElement[],
  ) => {
    const [minX, minY, maxX, maxY] = getCommonBounds(clipboardElements);

    const elementsCenterX = distance(minX, maxX) / 2;
    const elementsCenterY = distance(minY, maxY) / 2;

    const { x, y } = viewportCoordsToSceneCoords(
      { clientX: cursorX, clientY: cursorY },
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );

    const dx = x - elementsCenterX;
    const dy = y - elementsCenterY;
    const groupIdMap = new Map();

    const newElements = clipboardElements.map((element) =>
      duplicateElement(this.state.editingGroupId, groupIdMap, element, {
        x: element.x + dx - minX,
        y: element.y + dy - minY,
      }),
    );

    globalSceneState.replaceAllElements([
      ...globalSceneState.getElementsIncludingDeleted(),
      ...newElements,
    ]);
    history.resumeRecording();
    this.setState({
      selectedElementIds: newElements.reduce((map, element) => {
        map[element.id] = true;
        return map;
      }, {} as any),
    });
  };

  private addTextFromPaste(text: any) {
    const { x, y } = viewportCoordsToSceneCoords(
      { clientX: cursorX, clientY: cursorY },
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );

    const element = newTextElement({
      x: x,
      y: y,
      strokeColor: this.state.currentItemStrokeColor,
      backgroundColor: this.state.currentItemBackgroundColor,
      fillStyle: this.state.currentItemFillStyle,
      strokeWidth: this.state.currentItemStrokeWidth,
      strokeStyle: this.state.currentItemStrokeStyle,
      roughness: this.state.currentItemRoughness,
      opacity: this.state.currentItemOpacity,
      text: text,
      fontSize: this.state.currentItemFontSize,
      fontFamily: this.state.currentItemFontFamily,
      textAlign: this.state.currentItemTextAlign,
    });

    globalSceneState.replaceAllElements([
      ...globalSceneState.getElementsIncludingDeleted(),
      element,
    ]);
    this.setState({ selectedElementIds: { [element.id]: true } });
    history.resumeRecording();
  }

  // Collaboration

  setAppState = (obj: any) => {
    this.setState(obj);
  };

  removePointer = (event: React.PointerEvent<HTMLElement>) => {
    gesture.pointers.delete(event.pointerId);
  };

  toggleLock = () => {
    this.setState((prevState) => ({
      elementLocked: !prevState.elementLocked,
      elementType: prevState.elementLocked
        ? "selection"
        : prevState.elementType,
    }));
  };

  toggleZenMode = () => {
    this.setState({
      zenModeEnabled: !this.state.zenModeEnabled,
    });
  };

  // Portal-only
  setCollaborators(sockets: string[]) {
    this.setState((state) => {
      const collaborators: typeof state.collaborators = new Map();
      for (const socketID of sockets) {
        if (state.collaborators.has(socketID)) {
          collaborators.set(socketID, state.collaborators.get(socketID)!);
        } else {
          collaborators.set(socketID, {});
        }
      }
      return {
        ...state,
        collaborators,
      };
    });
  }

  private broadcastMouseLocation = (payload: {
    pointerCoords: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointerCoords"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {
    const data: SocketUpdateDataSource["MOUSE_LOCATION"] = {
      type: "MOUSE_LOCATION",
      payload: {
        socketID: this.props.socketId,
        pointerCoords: payload.pointerCoords,
        button: payload.button || "up",
        selectedElementIds: this.state.selectedElementIds,
        username: this.props.username,
      },
    };
    this.sendData(data);
  };

  // maybe should move to Portal
  broadcastScene = (sceneType: SCENE.INIT | SCENE.UPDATE, syncAll: boolean) => {
    if (sceneType === SCENE.INIT && !syncAll) {
      throw new Error("syncAll must be true when sending SCENE.INIT");
    }

    let syncableElements = getSyncableElements(
      globalSceneState.getElementsIncludingDeleted(),
    );

    if (!syncAll) {
      // sync out only the elements we think we need to to save bandwidth.
      // periodically we'll resync the whole thing to make sure no one diverges
      // due to a dropped message (server goes down etc).
      syncableElements = syncableElements.filter(
        (syncableElement) =>
          !this.broadcastedElementVersions.has(syncableElement.id) ||
          syncableElement.version >
            this.broadcastedElementVersions.get(syncableElement.id)!,
      );
    }

    const data: SocketUpdateDataSource[typeof sceneType] = {
      type: sceneType,
      payload: {
        elements: syncableElements,
      },
    };
    this.lastBroadcastedOrReceivedSceneVersion = Math.max(
      this.lastBroadcastedOrReceivedSceneVersion,
      getDrawingVersion(globalSceneState.getElementsIncludingDeleted()),
    );
    for (const syncableElement of syncableElements) {
      this.broadcastedElementVersions.set(
        syncableElement.id,
        syncableElement.version,
      );
    }
    this.sendData(data);
  };

  private onSceneUpdated = () => {
    this.setState({});
  };

  private updateCurrentCursorPosition = withBatchedUpdates(
    (event: MouseEvent) => {
      cursorX = event.x;
      cursorY = event.y;
    },
  );

  // Input handling

  private onKeyDown = withBatchedUpdates((event: KeyboardEvent) => {
    // ensures we don't prevent devTools select-element feature
    if (event[KEYS.CTRL_OR_CMD] && event.shiftKey && event.key === "C") {
      return;
    }

    if (
      (isWritableElement(event.target) && event.key !== KEYS.ESCAPE) ||
      // case: using arrows to move between buttons
      (isArrowKey(event.key) && isInputLike(event.target))
    ) {
      return;
    }

    if (event.key === KEYS.QUESTION_MARK) {
      this.setState({
        showShortcutsDialog: true,
      });
    }

    if (
      !event[KEYS.CTRL_OR_CMD] &&
      event.altKey &&
      event.keyCode === KEYS.Z_KEY_CODE
    ) {
      this.toggleZenMode();
    }

    if (event.code === "KeyC" && event.altKey && event.shiftKey) {
      this.copyToClipboardAsPng();
      event.preventDefault();
      return;
    }

    if (this.actionManager.handleKeyDown(event)) {
      return;
    }

    const shape = findShapeByKey(event.key);

    if (isArrowKey(event.key)) {
      const step = event.shiftKey
        ? ELEMENT_SHIFT_TRANSLATE_AMOUNT
        : ELEMENT_TRANSLATE_AMOUNT;
      globalSceneState.replaceAllElements(
        globalSceneState.getElementsIncludingDeleted().map((el) => {
          if (this.state.selectedElementIds[el.id]) {
            const update: { x?: number; y?: number } = {};
            if (event.key === KEYS.ARROW_LEFT) {
              update.x = el.x - step;
            } else if (event.key === KEYS.ARROW_RIGHT) {
              update.x = el.x + step;
            } else if (event.key === KEYS.ARROW_UP) {
              update.y = el.y - step;
            } else if (event.key === KEYS.ARROW_DOWN) {
              update.y = el.y + step;
            }
            return newElementWith(el, update);
          }
          return el;
        }),
      );
      event.preventDefault();
    } else if (event.key === KEYS.ENTER) {
      const selectedElements = getSelectedElements(
        globalSceneState.getElements(),
        this.state,
      );

      if (
        selectedElements.length === 1 &&
        !isLinearElement(selectedElements[0])
      ) {
        const selectedElement = selectedElements[0];
        const x = selectedElement.x + selectedElement.width / 2;
        const y = selectedElement.y + selectedElement.height / 2;

        this.startTextEditing({
          x: x,
          y: y,
        });
        event.preventDefault();
        return;
      }
    } else if (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      this.state.draggingElement === null
    ) {
      if (shapesShortcutKeys.includes(event.key.toLowerCase())) {
        this.selectShapeTool(shape);
      } else if (event.key === "q") {
        this.toggleLock();
      }
    }
    if (event.key === KEYS.SPACE && gesture.pointers.size === 0) {
      isHoldingSpace = true;
      this.setState({
        cursor: CURSOR_TYPE.GRABBING,
      });
    }
  });

  private onKeyUp = withBatchedUpdates((event: KeyboardEvent) => {
    if (event.key === KEYS.SPACE) {
      if (this.state.elementType === "selection") {
        this.setState({ cursor: "" });
      } else {
        this.setState({
          cursor: getCursorForShape(this.state.elementType),
          selectedElementIds: {},
          selectedGroupIds: {},
          editingGroupId: null,
        });
      }
      isHoldingSpace = false;
    }
  });

  private selectShapeTool(elementType: AppState["elementType"]) {
    if (!isHoldingSpace) {
      this.setState({ cursor: getCursorForShape(elementType) });
    }
    if (isToolIcon(this.props.window.document.activeElement)) {
      this.props.window.document.activeElement.blur();
    }
    if (elementType !== "selection") {
      this.setState({
        elementType,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      });
    } else {
      this.setState({ elementType });
    }
  }

  private onGestureStart = withBatchedUpdates((event: GestureEvent) => {
    event.preventDefault();
    gesture.initialScale = this.state.zoom;
  });

  private onGestureChange = withBatchedUpdates((event: GestureEvent) => {
    event.preventDefault();

    this.setState({
      zoom: getNormalizedZoom(gesture.initialScale! * event.scale),
    });
  });

  private onGestureEnd = withBatchedUpdates((event: GestureEvent) => {
    event.preventDefault();
    gesture.initialScale = null;
  });

  private setElements = (elements: readonly ExcalidrawElement[]) => {
    globalSceneState.replaceAllElements(elements);
  };

  private handleTextWysiwyg(
    element: ExcalidrawTextElement,
    {
      x,
      y,
      isExistingElement = false,
    }: { x: number; y: number; isExistingElement?: boolean },
  ) {
    const resetSelection = () => {
      this.setState({
        draggingElement: null,
        editingElement: null,
      });
    };

    const deleteElement = () => {
      globalSceneState.replaceAllElements([
        ...globalSceneState.getElementsIncludingDeleted().map((_element) => {
          if (_element.id === element.id) {
            return newElementWith(_element, { isDeleted: true });
          }
          return _element;
        }),
      ]);
    };

    const updateElement = (text: string) => {
      globalSceneState.replaceAllElements([
        ...globalSceneState.getElementsIncludingDeleted().map((_element) => {
          if (_element.id === element.id) {
            return newTextElement({
              ...(_element as ExcalidrawTextElement),
              x: element.x,
              y: element.y,
              text,
            });
          }
          return _element;
        }),
      ]);
    };

    textWysiwyg({
      id: element.id,
      x,
      y,
      initText: element.text,
      strokeColor: element.strokeColor,
      opacity: element.opacity,
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      angle: element.angle,
      textAlign: element.textAlign,
      zoom: this.state.zoom,
      onChange: withBatchedUpdates((text) => {
        if (text) {
          updateElement(text);
        } else {
          deleteElement();
        }
      }),
      onSubmit: withBatchedUpdates((text) => {
        updateElement(text);
        this.setState((prevState) => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [element.id]: true,
          },
        }));
        if (this.state.elementLocked) {
          this.setState({ cursor: getCursorForShape(this.state.elementType) });
        }
        history.resumeRecording();
        resetSelection();
      }),
      onCancel: withBatchedUpdates(() => {
        deleteElement();
        if (isExistingElement) {
          history.resumeRecording();
        }
        resetSelection();
      }),
      window: this.props.window,
    });
    // deselect all other elements when inserting text
    this.setState({
      selectedElementIds: {},
      selectedGroupIds: {},
      editingGroupId: null,
    });

    // do an initial update to re-initialize element position since we were
    //  modifying element's x/y for sake of editor (case: syncing to remote)
    updateElement(element.text);
  }

  private startTextEditing = ({
    x,
    y,
    clientX,
    clientY,
    centerIfPossible = true,
  }: {
    x: number;
    y: number;
    clientX?: number;
    clientY?: number;
    centerIfPossible?: boolean;
  }) => {
    const elementAtPosition = getElementAtPosition(
      globalSceneState.getElements(),
      this.state,
      x,
      y,
      this.state.zoom,
    );

    const element =
      elementAtPosition && isTextElement(elementAtPosition)
        ? elementAtPosition
        : newTextElement({
            x: x,
            y: y,
            strokeColor: this.state.currentItemStrokeColor,
            backgroundColor: this.state.currentItemBackgroundColor,
            fillStyle: this.state.currentItemFillStyle,
            strokeWidth: this.state.currentItemStrokeWidth,
            strokeStyle: this.state.currentItemStrokeStyle,
            roughness: this.state.currentItemRoughness,
            opacity: this.state.currentItemOpacity,
            text: "",
            fontSize: this.state.currentItemFontSize,
            fontFamily: this.state.currentItemFontFamily,
            textAlign: this.state.currentItemTextAlign,
          });

    this.setState({ editingElement: element });

    let textX = clientX || x;
    let textY = clientY || y;

    let isExistingTextElement = false;

    if (elementAtPosition && isTextElement(elementAtPosition)) {
      isExistingTextElement = true;
      const centerElementX = elementAtPosition.x + elementAtPosition.width / 2;
      const centerElementY = elementAtPosition.y + elementAtPosition.height / 2;

      const {
        x: centerElementXInViewport,
        y: centerElementYInViewport,
      } = sceneCoordsToViewportCoords(
        { sceneX: centerElementX, sceneY: centerElementY },
        this.state,
        this.canvas,
        this.props.window.devicePixelRatio,
      );

      textX = centerElementXInViewport;
      textY = centerElementYInViewport;

      // x and y will change after calling newTextElement function
      mutateElement(element, {
        x: centerElementX,
        y: centerElementY,
      });
    } else {
      globalSceneState.replaceAllElements([
        ...globalSceneState.getElementsIncludingDeleted(),
        element,
      ]);

      if (centerIfPossible) {
        const snappedToCenterPosition = this.getTextWysiwygSnappedToCenterPosition(
          x,
          y,
          this.state,
          this.canvas,
          this.props.window.devicePixelRatio,
        );

        if (snappedToCenterPosition) {
          mutateElement(element, {
            x: snappedToCenterPosition.elementCenterX,
            y: snappedToCenterPosition.elementCenterY,
          });
          textX = snappedToCenterPosition.wysiwygX;
          textY = snappedToCenterPosition.wysiwygY;
        }
      }
    }

    this.setState({
      editingElement: element,
    });

    this.handleTextWysiwyg(element, {
      x: textX,
      y: textY,
      isExistingElement: isExistingTextElement,
    });
  };

  private handleCanvasDoubleClick = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    // case: double-clicking with arrow/line tool selected would both create
    //  text and enter multiElement mode
    if (this.state.multiElement) {
      return;
    }

    this.setState({ cursor: "" });

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );

    const selectedGroupIds = getSelectedGroupIds(this.state);

    if (selectedGroupIds.length > 0) {
      const elements = globalSceneState.getElements();
      const hitElement = getElementAtPosition(
        elements,
        this.state,
        x,
        y,
        this.state.zoom,
      );

      const selectedGroupId =
        hitElement &&
        getSelectedGroupIdForElement(hitElement, this.state.selectedGroupIds);

      if (selectedGroupId) {
        this.setState((prevState) =>
          selectGroupsForSelectedElements(
            {
              ...prevState,
              editingGroupId: selectedGroupId,
              selectedElementIds: { [hitElement!.id]: true },
              selectedGroupIds: {},
            },
            globalSceneState.getElements(),
          ),
        );
        return;
      }
    }

    this.setState({ cursor: "" });

    this.startTextEditing({
      x: x,
      y: y,
      clientX: event.clientX,
      clientY: event.clientY,
      centerIfPossible: !event.altKey,
    });
  };

  private handleCanvasPointerMove = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    this.savePointer(event.clientX, event.clientY, this.state.cursorButton);

    if (gesture.pointers.has(event.pointerId)) {
      gesture.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    }

    if (gesture.pointers.size === 2) {
      const center = getCenter(gesture.pointers);
      const deltaX = center.x - gesture.lastCenter!.x;
      const deltaY = center.y - gesture.lastCenter!.y;
      gesture.lastCenter = center;

      const distance = getDistance(Array.from(gesture.pointers.values()));
      const scaleFactor = distance / gesture.initialDistance!;

      this.setState({
        scrollX: normalizeScroll(this.state.scrollX + deltaX / this.state.zoom),
        scrollY: normalizeScroll(this.state.scrollY + deltaY / this.state.zoom),
        zoom: getNormalizedZoom(gesture.initialScale! * scaleFactor),
        shouldCacheIgnoreZoom: true,
      });
      this.resetShouldCacheIgnoreZoomDebounced();
    } else {
      gesture.lastCenter = gesture.initialDistance = gesture.initialScale = null;
    }

    if (isHoldingSpace || isPanning || isDraggingScrollBar) {
      return;
    }
    const {
      isOverHorizontalScrollBar,
      isOverVerticalScrollBar,
    } = isOverScrollBars(currentScrollBars, event.clientX, event.clientY);
    const isOverScrollBar =
      isOverVerticalScrollBar || isOverHorizontalScrollBar;
    if (!this.state.draggingElement && !this.state.multiElement) {
      if (isOverScrollBar) {
        this.setState({ cursor: "" });
      } else {
        this.setState({ cursor: getCursorForShape(this.state.elementType) });
      }
    }

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );
    if (this.state.multiElement) {
      const { multiElement } = this.state;
      const { x: rx, y: ry } = multiElement;

      const { points, lastCommittedPoint } = multiElement;
      const lastPoint = points[points.length - 1];

      this.setState({ cursor: getCursorForShape(this.state.elementType) });

      if (lastPoint === lastCommittedPoint) {
        // if we haven't yet created a temp point and we're beyond commit-zone
        //  threshold, add a point
        if (
          distance2d(x - rx, y - ry, lastPoint[0], lastPoint[1]) >=
          LINE_CONFIRM_THRESHOLD
        ) {
          mutateElement(multiElement, {
            points: [...points, [x - rx, y - ry]],
          });
        } else {
          this.setState({
            cursor: CURSOR_TYPE.POINTER,
          });
          // in this branch, we're inside the commit zone, and no uncommitted
          //  point exists. Thus do nothing (don't add/remove points).
        }
      } else {
        // cursor moved inside commit zone, and there's uncommitted point,
        //  thus remove it
        if (
          points.length > 2 &&
          lastCommittedPoint &&
          distance2d(
            x - rx,
            y - ry,
            lastCommittedPoint[0],
            lastCommittedPoint[1],
          ) < LINE_CONFIRM_THRESHOLD
        ) {
          this.setState({
            cursor: CURSOR_TYPE.POINTER,
          });
          mutateElement(multiElement, {
            points: points.slice(0, -1),
          });
        } else {
          if (isPathALoop(points)) {
            this.setState({
              cursor: CURSOR_TYPE.POINTER,
            });
          }
          // update last uncommitted point
          mutateElement(multiElement, {
            points: [...points.slice(0, -1), [x - rx, y - ry]],
          });
        }
      }
      return;
    }

    const hasDeselectedButton = Boolean(event.buttons);
    if (
      hasDeselectedButton ||
      (this.state.elementType !== "selection" &&
        this.state.elementType !== "text")
    ) {
      return;
    }

    const elements = globalSceneState.getElements();

    const selectedElements = getSelectedElements(elements, this.state);
    if (selectedElements.length === 1 && !isOverScrollBar) {
      const elementWithResizeHandler = getElementWithResizeHandler(
        elements,
        this.state,
        { x, y },
        this.state.zoom,
        event.pointerType,
      );
      if (elementWithResizeHandler && elementWithResizeHandler.resizeHandle) {
        this.setState({
          cursor: getCursorForResizingElement(elementWithResizeHandler),
        });

        return;
      }
    } else if (selectedElements.length > 1 && !isOverScrollBar) {
      if (canResizeMutlipleElements(selectedElements)) {
        const resizeHandle = getResizeHandlerFromCoords(
          getCommonBounds(selectedElements),
          { x, y },
          this.state.zoom,
          event.pointerType,
        );
        if (resizeHandle) {
          this.setState({
            cursor: getCursorForResizingElement({
              resizeHandle,
            }),
          });

          return;
        }
      }
    }
    const hitElement = getElementAtPosition(
      elements,
      this.state,
      x,
      y,
      this.state.zoom,
    );
    if (this.state.elementType === "text") {
      this.setState({
        cursor: isTextElement(hitElement)
          ? CURSOR_TYPE.TEXT
          : CURSOR_TYPE.CROSSHAIR,
      });
    } else {
      this.setState({
        cursor: hitElement && !isOverScrollBar ? "move" : "",
      });
    }
  };

  private handleCanvasPointerDown = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    event.persist();

    if (lastPointerUp !== null) {
      // Unfortunately, sometimes we don't get a pointerup after a pointerdown,
      // this can happen when a contextual menu or alert is triggered. In order to avoid
      // being in a weird state, we clean up on the next pointerdown
      lastPointerUp(event);
    }

    if (isPanning) {
      return;
    }

    this.setState({
      lastPointerDownWith: event.pointerType,
      cursorButton: "down",
    });
    this.savePointer(event.clientX, event.clientY, "down");

    // pan canvas on wheel button drag or space+drag
    if (
      gesture.pointers.size === 0 &&
      (event.button === POINTER_BUTTON.WHEEL ||
        (event.button === POINTER_BUTTON.MAIN && isHoldingSpace))
    ) {
      isPanning = true;

      let nextPastePrevented = false;
      const isLinux = /Linux/.test(this.props.window.navigator.platform);
      this.setState({
        cursor: CURSOR_TYPE.GRABBING,
      });
      let { clientX: lastX, clientY: lastY } = event;
      const onPointerMove = withBatchedUpdates((event: PointerEvent) => {
        const deltaX = lastX - event.clientX;
        const deltaY = lastY - event.clientY;
        lastX = event.clientX;
        lastY = event.clientY;

        /*
         * Prevent paste event if we move while middle clicking on Linux.
         * See issue #1383.
         */
        if (
          isLinux &&
          !nextPastePrevented &&
          (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1)
        ) {
          nextPastePrevented = true;

          /* Prevent the next paste event */
          const preventNextPaste = (event: ClipboardEvent) => {
            this.props.window.document.body.removeEventListener(
              EVENT.PASTE,
              preventNextPaste,
            );
            event.stopPropagation();
          };

          /*
           * Reenable next paste in case of disabled middle click paste for
           * any reason:
           * - rigth click paste
           * - empty clipboard
           */
          const enableNextPaste = () => {
            setTimeout(() => {
              this.props.window.document.body.removeEventListener(
                EVENT.PASTE,
                preventNextPaste,
              );
              this.props.window.removeEventListener(
                EVENT.POINTER_UP,
                enableNextPaste,
              );
            }, 100);
          };

          this.props.window.document.body.addEventListener(
            EVENT.PASTE,
            preventNextPaste,
          );
          this.props.window.addEventListener(EVENT.POINTER_UP, enableNextPaste);
        }

        this.setState({
          scrollX: normalizeScroll(
            this.state.scrollX - deltaX / this.state.zoom,
          ),
          scrollY: normalizeScroll(
            this.state.scrollY - deltaY / this.state.zoom,
          ),
        });
      });
      const teardown = withBatchedUpdates(
        (lastPointerUp = () => {
          lastPointerUp = null;
          isPanning = false;
          if (!isHoldingSpace) {
            this.setState({
              cursor: getCursorForShape(this.state.elementType),
            });
          }
          this.setState({
            cursorButton: "up",
          });
          this.savePointer(event.clientX, event.clientY, "up");
          this.props.window.removeEventListener(
            EVENT.POINTER_MOVE,
            onPointerMove,
          );
          this.props.window.removeEventListener(EVENT.POINTER_UP, teardown);
          this.props.window.removeEventListener(EVENT.BLUR, teardown);
        }),
      );
      this.props.window.addEventListener(EVENT.BLUR, teardown);
      this.props.window.addEventListener(EVENT.POINTER_MOVE, onPointerMove, {
        passive: true,
      });
      this.props.window.addEventListener(EVENT.POINTER_UP, teardown);
      return;
    }

    // only handle left mouse button or touch
    if (
      event.button !== POINTER_BUTTON.MAIN &&
      event.button !== POINTER_BUTTON.TOUCH
    ) {
      return;
    }

    gesture.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (gesture.pointers.size === 2) {
      gesture.lastCenter = getCenter(gesture.pointers);
      gesture.initialScale = this.state.zoom;
      gesture.initialDistance = getDistance(
        Array.from(gesture.pointers.values()),
      );
    }

    // fixes pointermove causing selection of UI texts #32
    event.preventDefault();
    // Preventing the event above disables default behavior
    //  of defocusing potentially focused element, which is what we
    //  want when clicking inside the canvas.
    if (this.props.window.document.activeElement instanceof HTMLElement) {
      this.props.window.document.activeElement.blur();
    }

    // don't select while panning
    if (gesture.pointers.size > 1) {
      return;
    }

    // Handle scrollbars dragging
    const {
      isOverHorizontalScrollBar,
      isOverVerticalScrollBar,
    } = isOverScrollBars(currentScrollBars, event.clientX, event.clientY);

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );
    let lastX = x;
    let lastY = y;

    if (
      (isOverHorizontalScrollBar || isOverVerticalScrollBar) &&
      !this.state.multiElement
    ) {
      isDraggingScrollBar = true;
      lastX = event.clientX;
      lastY = event.clientY;
      const onPointerMove = withBatchedUpdates((event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        if (isOverHorizontalScrollBar) {
          const x = event.clientX;
          const dx = x - lastX;
          this.setState({
            scrollX: normalizeScroll(this.state.scrollX - dx / this.state.zoom),
          });
          lastX = x;
          return;
        }

        if (isOverVerticalScrollBar) {
          const y = event.clientY;
          const dy = y - lastY;
          this.setState({
            scrollY: normalizeScroll(this.state.scrollY - dy / this.state.zoom),
          });
          lastY = y;
        }
      });

      const onPointerUp = withBatchedUpdates(() => {
        isDraggingScrollBar = false;
        this.setState({ cursor: getCursorForShape(this.state.elementType) });
        lastPointerUp = null;
        this.setState({
          cursorButton: "up",
        });
        this.savePointer(event.clientX, event.clientY, "up");
        this.props.window.removeEventListener(
          EVENT.POINTER_MOVE,
          onPointerMove,
        );
        this.props.window.removeEventListener(EVENT.POINTER_UP, onPointerUp);
      });

      lastPointerUp = onPointerUp;

      this.props.window.addEventListener(EVENT.POINTER_MOVE, onPointerMove);
      this.props.window.addEventListener(EVENT.POINTER_UP, onPointerUp);
      return;
    }

    const originX = x;
    const originY = y;

    type ResizeTestType = ReturnType<typeof resizeTest>;
    let resizeHandle: ResizeTestType = false;
    const setResizeHandle = (nextResizeHandle: ResizeTestType) => {
      resizeHandle = nextResizeHandle;
    };
    let resizeOffsetXY: [number, number] = [0, 0];
    let resizeArrowDirection: "origin" | "end" = "origin";
    let isResizingElements = false;
    let draggingOccurred = false;
    let hitElement: ExcalidrawElement | null = null;
    let hitElementWasAddedToSelection = false;

    if (this.state.elementType === "selection") {
      const elements = globalSceneState.getElements();
      const selectedElements = getSelectedElements(elements, this.state);
      if (selectedElements.length === 1) {
        const elementWithResizeHandler = getElementWithResizeHandler(
          elements,
          this.state,
          { x, y },
          this.state.zoom,
          event.pointerType,
        );
        if (elementWithResizeHandler) {
          this.setState({
            resizingElement: elementWithResizeHandler
              ? elementWithResizeHandler.element
              : null,
          });
          resizeHandle = elementWithResizeHandler.resizeHandle;
          this.setState({
            cursor: getCursorForResizingElement(elementWithResizeHandler),
          });
          isResizingElements = true;
        }
      } else if (selectedElements.length > 1) {
        if (canResizeMutlipleElements(selectedElements)) {
          resizeHandle = getResizeHandlerFromCoords(
            getCommonBounds(selectedElements),
            { x, y },
            this.state.zoom,
            event.pointerType,
          );
          if (resizeHandle) {
            this.setState({
              cursor: getCursorForResizingElement({
                resizeHandle,
              }),
            });
            isResizingElements = true;
          }
        }
      }
      if (isResizingElements) {
        resizeOffsetXY = getResizeOffsetXY(
          resizeHandle,
          selectedElements,
          x,
          y,
        );
        if (
          selectedElements.length === 1 &&
          isLinearElement(selectedElements[0]) &&
          selectedElements[0].points.length === 2
        ) {
          resizeArrowDirection = getResizeArrowDirection(
            resizeHandle,
            selectedElements[0],
          );
        }
      }
      if (!isResizingElements) {
        hitElement = getElementAtPosition(
          elements,
          this.state,
          x,
          y,
          this.state.zoom,
        );
        // clear selection if shift is not clicked
        if (
          !(hitElement && this.state.selectedElementIds[hitElement.id]) &&
          !event.shiftKey
        ) {
          this.setState((prevState) => ({
            selectedElementIds: {},
            selectedGroupIds: {},
            editingGroupId:
              prevState.editingGroupId &&
              hitElement &&
              isElementInGroup(hitElement, prevState.editingGroupId)
                ? prevState.editingGroupId
                : null,
          }));
        }

        // If we click on something
        if (hitElement) {
          // deselect if item is selected
          // if shift is not clicked, this will always return true
          // otherwise, it will trigger selection based on current
          // state of the box
          if (!this.state.selectedElementIds[hitElement.id]) {
            // if we are currently editing a group, treat all selections outside of the group
            // as exiting editing mode.
            if (
              this.state.editingGroupId &&
              !isElementInGroup(hitElement, this.state.editingGroupId)
            ) {
              this.setState({
                selectedElementIds: {},
                selectedGroupIds: {},
                editingGroupId: null,
              });
              return;
            }
            this.setState((prevState) => {
              return selectGroupsForSelectedElements(
                {
                  ...prevState,
                  selectedElementIds: {
                    ...prevState.selectedElementIds,
                    [hitElement!.id]: true,
                  },
                },
                globalSceneState.getElements(),
              );
            });
            // TODO: this is strange...
            globalSceneState.replaceAllElements(
              globalSceneState.getElementsIncludingDeleted(),
            );
            hitElementWasAddedToSelection = true;
          }
        }
      }
    } else {
      this.setState({
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      });
    }

    if (this.state.elementType === "text") {
      // if we're currently still editing text, clicking outside
      //  should only finalize it, not create another (irrespective
      //  of state.elementLocked)
      if (this.state.editingElement?.type === "text") {
        return;
      }

      const { x, y } = viewportCoordsToSceneCoords(
        event,
        this.state,
        this.canvas,
        this.props.window.devicePixelRatio,
      );

      this.startTextEditing({
        x: x,
        y: y,
        clientX: event.clientX,
        clientY: event.clientY,
        centerIfPossible: !event.altKey,
      });

      this.setState({ cursor: "" });
      if (!this.state.elementLocked) {
        this.setState({
          elementType: "selection",
        });
      }
      return;
    } else if (
      this.state.elementType === "arrow" ||
      this.state.elementType === "draw" ||
      this.state.elementType === "line"
    ) {
      if (this.state.multiElement) {
        const { multiElement } = this.state;

        // finalize if completing a loop
        if (multiElement.type === "line" && isPathALoop(multiElement.points)) {
          mutateElement(multiElement, {
            lastCommittedPoint:
              multiElement.points[multiElement.points.length - 1],
          });
          this.actionManager.executeAction(actionFinalize);
          this.setState({});
          return;
        }

        const { x: rx, y: ry, lastCommittedPoint } = multiElement;

        // clicking inside commit zone → finalize arrow
        if (
          multiElement.points.length > 1 &&
          lastCommittedPoint &&
          distance2d(
            x - rx,
            y - ry,
            lastCommittedPoint[0],
            lastCommittedPoint[1],
          ) < LINE_CONFIRM_THRESHOLD
        ) {
          this.actionManager.executeAction(actionFinalize);
          this.setState({});
          return;
        }

        this.setState((prevState) => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [multiElement.id]: true,
          },
        }));
        // clicking outside commit zone → update reference for last committed
        //  point
        mutateElement(multiElement, {
          lastCommittedPoint:
            multiElement.points[multiElement.points.length - 1],
        });
        this.setState({
          cursor: CURSOR_TYPE.POINTER,
        });
      } else {
        const element = newLinearElement({
          type: this.state.elementType,
          x: x,
          y: y,
          strokeColor: this.state.currentItemStrokeColor,
          backgroundColor: this.state.currentItemBackgroundColor,
          fillStyle: this.state.currentItemFillStyle,
          strokeWidth: this.state.currentItemStrokeWidth,
          strokeStyle: this.state.currentItemStrokeStyle,
          roughness: this.state.currentItemRoughness,
          opacity: this.state.currentItemOpacity,
        });
        this.setState((prevState) => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [element.id]: false,
          },
        }));
        mutateElement(element, {
          points: [...element.points, [0, 0]],
        });
        globalSceneState.replaceAllElements([
          ...globalSceneState.getElementsIncludingDeleted(),
          element,
        ]);
        this.setState({
          draggingElement: element,
          editingElement: element,
        });
      }
    } else {
      const element = newElement({
        type: this.state.elementType,
        x: x,
        y: y,
        strokeColor: this.state.currentItemStrokeColor,
        backgroundColor: this.state.currentItemBackgroundColor,
        fillStyle: this.state.currentItemFillStyle,
        strokeWidth: this.state.currentItemStrokeWidth,
        strokeStyle: this.state.currentItemStrokeStyle,
        roughness: this.state.currentItemRoughness,
        opacity: this.state.currentItemOpacity,
      });

      if (element.type === "selection") {
        this.setState({
          selectionElement: element,
          draggingElement: element,
        });
      } else {
        globalSceneState.replaceAllElements([
          ...globalSceneState.getElementsIncludingDeleted(),
          element,
        ]);
        this.setState({
          multiElement: null,
          draggingElement: element,
          editingElement: element,
        });
      }
    }

    let selectedElementWasDuplicated = false;

    const onPointerMove = withBatchedUpdates((event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (isOverHorizontalScrollBar) {
        const x = event.clientX;
        const dx = x - lastX;
        this.setState({
          scrollX: normalizeScroll(this.state.scrollX - dx / this.state.zoom),
        });
        lastX = x;
        return;
      }

      if (isOverVerticalScrollBar) {
        const y = event.clientY;
        const dy = y - lastY;
        this.setState({
          scrollY: normalizeScroll(this.state.scrollY - dy / this.state.zoom),
        });
        lastY = y;
        return;
      }

      const { x, y } = viewportCoordsToSceneCoords(
        event,
        this.state,
        this.canvas,
        this.props.window.devicePixelRatio,
      );

      // for arrows/lines, don't start dragging until a given threshold
      //  to ensure we don't create a 2-point arrow by mistake when
      //  user clicks mouse in a way that it moves a tiny bit (thus
      //  triggering pointermove)
      if (
        !draggingOccurred &&
        (this.state.elementType === "arrow" ||
          this.state.elementType === "line")
      ) {
        if (distance2d(x, y, originX, originY) < DRAGGING_THRESHOLD) {
          return;
        }
      }

      if (isResizingElements) {
        const selectedElements = getSelectedElements(
          globalSceneState.getElements(),
          this.state,
        );
        this.setState({
          isResizing: resizeHandle && resizeHandle !== "rotation",
          isRotating: resizeHandle === "rotation",
        });
        if (
          resizeElements(
            resizeHandle,
            setResizeHandle,
            selectedElements,
            resizeArrowDirection,
            event,
            x - resizeOffsetXY[0],
            y - resizeOffsetXY[1],
            (cursor: string) => {
              this.setState({ cursor });
            },
          )
        ) {
          return;
        }
      }

      if (hitElement && this.state.selectedElementIds[hitElement.id]) {
        // Marking that click was used for dragging to check
        // if elements should be deselected on pointerup
        draggingOccurred = true;
        const selectedElements = getSelectedElements(
          globalSceneState.getElements(),
          this.state,
        );
        if (selectedElements.length > 0) {
          const { x, y } = viewportCoordsToSceneCoords(
            event,
            this.state,
            this.canvas,
            this.props.window.devicePixelRatio,
          );

          selectedElements.forEach((element) => {
            mutateElement(element, {
              x: element.x + x - lastX,
              y: element.y + y - lastY,
            });
          });
          lastX = x;
          lastY = y;

          // We duplicate the selected element if alt is pressed on pointer move
          if (event.altKey && !selectedElementWasDuplicated) {
            // Move the currently selected elements to the top of the z index stack, and
            // put the duplicates where the selected elements used to be.
            // (the origin point where the dragging started)

            selectedElementWasDuplicated = true;

            const nextElements = [];
            const elementsToAppend = [];
            const groupIdMap = new Map();
            for (const element of globalSceneState.getElementsIncludingDeleted()) {
              if (
                this.state.selectedElementIds[element.id] ||
                // case: the state.selectedElementIds might not have been
                //  updated yet by the time this mousemove event is fired
                (element.id === hitElement.id && hitElementWasAddedToSelection)
              ) {
                const duplicatedElement = duplicateElement(
                  this.state.editingGroupId,
                  groupIdMap,
                  element,
                );
                mutateElement(duplicatedElement, {
                  x: duplicatedElement.x + (originX - lastX),
                  y: duplicatedElement.y + (originY - lastY),
                });
                nextElements.push(duplicatedElement);
                elementsToAppend.push(element);
              } else {
                nextElements.push(element);
              }
            }
            globalSceneState.replaceAllElements([
              ...nextElements,
              ...elementsToAppend,
            ]);
          }
          return;
        }
      }

      // It is very important to read this.state within each move event,
      // otherwise we would read a stale one!
      const draggingElement = this.state.draggingElement;
      if (!draggingElement) {
        return;
      }

      let width = distance(originX, x);
      let height = distance(originY, y);

      if (isLinearElement(draggingElement)) {
        draggingOccurred = true;
        const points = draggingElement.points;
        let dx = x - draggingElement.x;
        let dy = y - draggingElement.y;

        if (event.shiftKey && points.length === 2) {
          ({ width: dx, height: dy } = getPerfectElementSize(
            this.state.elementType,
            dx,
            dy,
          ));
        }

        if (points.length === 1) {
          mutateElement(draggingElement, { points: [...points, [dx, dy]] });
        } else if (points.length > 1) {
          if (draggingElement.type === "draw") {
            mutateElement(draggingElement, {
              points: simplify([...(points as Point[]), [dx, dy]], 0.7),
            });
          } else {
            mutateElement(draggingElement, {
              points: [...points.slice(0, -1), [dx, dy]],
            });
          }
        }
      } else {
        if (getResizeWithSidesSameLengthKey(event)) {
          ({ width, height } = getPerfectElementSize(
            this.state.elementType,
            width,
            y < originY ? -height : height,
          ));

          if (height < 0) {
            height = -height;
          }
        }

        let newX = x < originX ? originX - width : originX;
        let newY = y < originY ? originY - height : originY;

        if (getResizeCenterPointKey(event)) {
          width += width;
          height += height;
          newX = originX - width / 2;
          newY = originY - height / 2;
        }

        mutateElement(draggingElement, {
          x: newX,
          y: newY,
          width: width,
          height: height,
        });
      }

      if (this.state.elementType === "selection") {
        const elements = globalSceneState.getElements();
        if (!event.shiftKey && isSomeElementSelected(elements, this.state)) {
          this.setState({
            selectedElementIds: {},
            selectedGroupIds: {},
            editingGroupId: null,
          });
        }
        const elementsWithinSelection = getElementsWithinSelection(
          elements,
          draggingElement,
        );
        this.setState((prevState) =>
          selectGroupsForSelectedElements(
            {
              ...prevState,
              selectedElementIds: {
                ...prevState.selectedElementIds,
                ...elementsWithinSelection.reduce((map, element) => {
                  map[element.id] = true;
                  return map;
                }, {} as any),
              },
            },
            globalSceneState.getElements(),
          ),
        );
      }
    });

    const onPointerUp = withBatchedUpdates((childEvent: PointerEvent) => {
      const {
        draggingElement,
        resizingElement,
        multiElement,
        elementType,
        elementLocked,
      } = this.state;

      this.setState({
        isResizing: false,
        isRotating: false,
        resizingElement: null,
        selectionElement: null,
        cursorButton: "up",
        editingElement: multiElement ? this.state.editingElement : null,
      });

      this.savePointer(childEvent.clientX, childEvent.clientY, "up");

      lastPointerUp = null;

      this.props.window.removeEventListener(EVENT.POINTER_MOVE, onPointerMove);
      this.props.window.removeEventListener(EVENT.POINTER_UP, onPointerUp);

      if (draggingElement?.type === "draw") {
        this.actionManager.executeAction(actionFinalize);
        this.setState({});
        return;
      }
      if (isLinearElement(draggingElement)) {
        if (draggingElement!.points.length > 1) {
          history.resumeRecording();
        }
        if (!draggingOccurred && draggingElement && !multiElement) {
          const { x, y } = viewportCoordsToSceneCoords(
            childEvent,
            this.state,
            this.canvas,
            this.props.window.devicePixelRatio,
          );
          mutateElement(draggingElement, {
            points: [
              ...draggingElement.points,
              [x - draggingElement.x, y - draggingElement.y],
            ],
          });
          this.setState({
            multiElement: draggingElement,
            editingElement: this.state.draggingElement,
          });
        } else if (draggingOccurred && !multiElement) {
          if (!elementLocked) {
            this.setState({ cursor: "" });
            this.setState((prevState) => ({
              draggingElement: null,
              elementType: "selection",
              selectedElementIds: {
                ...prevState.selectedElementIds,
                [this.state.draggingElement!.id]: true,
              },
            }));
          } else {
            this.setState((prevState) => ({
              draggingElement: null,
              selectedElementIds: {
                ...prevState.selectedElementIds,
                [this.state.draggingElement!.id]: true,
              },
            }));
          }
        }
        return;
      }

      if (
        elementType !== "selection" &&
        draggingElement &&
        isInvisiblySmallElement(draggingElement)
      ) {
        // remove invisible element which was added in onPointerDown
        globalSceneState.replaceAllElements(
          globalSceneState.getElementsIncludingDeleted().slice(0, -1),
        );
        this.setState({
          draggingElement: null,
        });
        return;
      }

      normalizeDimensions(draggingElement);

      if (resizingElement) {
        history.resumeRecording();
      }

      if (resizingElement && isInvisiblySmallElement(resizingElement)) {
        globalSceneState.replaceAllElements(
          globalSceneState
            .getElementsIncludingDeleted()
            .filter((el) => el.id !== resizingElement.id),
        );
      }

      // If click occurred on already selected element
      // it is needed to remove selection from other elements
      // or if SHIFT or META key pressed remove selection
      // from hitted element
      //
      // If click occurred and elements were dragged or some element
      // was added to selection (on pointerdown phase) we need to keep
      // selection unchanged
      if (
        getSelectedGroupIds(this.state).length === 0 &&
        hitElement &&
        !draggingOccurred &&
        !hitElementWasAddedToSelection
      ) {
        if (childEvent.shiftKey) {
          this.setState((prevState) => ({
            selectedElementIds: {
              ...prevState.selectedElementIds,
              [hitElement!.id]: false,
            },
          }));
        } else {
          this.setState((_prevState) => ({
            selectedElementIds: { [hitElement!.id]: true },
          }));
        }
      }

      if (draggingElement === null) {
        // if no element is clicked, clear the selection and redraw
        this.setState({
          selectedElementIds: {},
          selectedGroupIds: {},
          editingGroupId: null,
        });
        return;
      }

      if (!elementLocked) {
        this.setState((prevState) => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [draggingElement.id]: true,
          },
        }));
      }

      if (
        elementType !== "selection" ||
        isSomeElementSelected(globalSceneState.getElements(), this.state)
      ) {
        history.resumeRecording();
      }

      if (!elementLocked) {
        this.setState({
          cursor: "",
          draggingElement: null,
          elementType: "selection",
        });
      } else {
        this.setState({
          draggingElement: null,
        });
      }
    });

    lastPointerUp = onPointerUp;

    this.props.window.addEventListener(EVENT.POINTER_MOVE, onPointerMove);
    this.props.window.addEventListener(EVENT.POINTER_UP, onPointerUp);
  };

  private handleCanvasRef = (canvas: HTMLCanvasElement) => {
    // canvas is null when unmounting
    if (canvas !== null) {
      this.canvas = canvas;
      this.rc = rough.canvas(this.canvas);

      this.canvas.addEventListener(EVENT.WHEEL, this.handleWheel, {
        passive: false,
      });
      this.canvas.addEventListener(EVENT.TOUCH_START, this.onTapStart);
    } else {
      this.canvas?.removeEventListener(EVENT.WHEEL, this.handleWheel);
      this.canvas?.removeEventListener(EVENT.TOUCH_START, this.onTapStart);
    }
  };

  private handleCanvasContextMenu = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    event.preventDefault();

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );

    const elements = globalSceneState.getElements();
    const element = getElementAtPosition(
      elements,
      this.state,
      x,
      y,
      this.state.zoom,
    );
    if (!element) {
      ContextMenu.push({
        options: [
          this.props.window.navigator.clipboard && {
            label: t("labels.paste"),
            action: () => this.pasteFromClipboard(null),
          },
          probablySupportsClipboardBlob &&
            elements.length > 0 && {
              label: t("labels.copyAsPng"),
              action: this.copyToClipboardAsPng,
            },
          probablySupportsClipboardWriteText &&
            elements.length > 0 && {
              label: t("labels.copyAsSvg"),
              action: this.copyToClipboardAsSvg,
            },
          ...this.actionManager.getContextMenuItems((action) =>
            this.canvasOnlyActions.includes(action.name),
          ),
        ],
        top: event.clientY,
        left: event.clientX,
      });
      return;
    }

    if (!this.state.selectedElementIds[element.id]) {
      this.setState({ selectedElementIds: { [element.id]: true } });
    }

    ContextMenu.push({
      options: [
        this.props.window.navigator.clipboard && {
          label: t("labels.copy"),
          action: this.copyAll,
        },
        this.props.window.navigator.clipboard && {
          label: t("labels.paste"),
          action: () => this.pasteFromClipboard(null),
        },
        probablySupportsClipboardBlob && {
          label: t("labels.copyAsPng"),
          action: this.copyToClipboardAsPng,
        },
        probablySupportsClipboardWriteText && {
          label: t("labels.copyAsSvg"),
          action: this.copyToClipboardAsSvg,
        },
        ...this.actionManager.getContextMenuItems(
          (action) => !this.canvasOnlyActions.includes(action.name),
        ),
      ],
      top: event.clientY,
      left: event.clientX,
    });
  };

  private handleWheel = withBatchedUpdates((event: WheelEvent) => {
    event.preventDefault();
    const { deltaX, deltaY } = event;

    // note that event.ctrlKey is necessary to handle pinch zooming
    if (event.metaKey || event.ctrlKey) {
      const sign = Math.sign(deltaY);
      const MAX_STEP = 10;
      let delta = Math.abs(deltaY);
      if (delta > MAX_STEP) {
        delta = MAX_STEP;
      }
      delta *= sign;
      this.setState(({ zoom }) => ({
        zoom: getNormalizedZoom(zoom - delta / 100),
      }));
      return;
    }

    // scroll horizontally when shift pressed
    if (event.shiftKey) {
      this.setState(({ zoom, scrollX }) => ({
        // on Mac, shift+wheel tends to result in deltaX
        scrollX: normalizeScroll(scrollX - (deltaY || deltaX) / zoom),
      }));
      return;
    }

    this.setState(({ zoom, scrollX, scrollY }) => ({
      scrollX: normalizeScroll(scrollX - deltaX / zoom),
      scrollY: normalizeScroll(scrollY - deltaY / zoom),
    }));
  });

  private getTextWysiwygSnappedToCenterPosition(
    x: number,
    y: number,
    state: {
      scrollX: FlooredNumber;
      scrollY: FlooredNumber;
      zoom: number;
    },
    canvas: HTMLCanvasElement | null,
    scale: number,
  ) {
    const elementClickedInside = getElementContainingPosition(
      globalSceneState.getElementsIncludingDeleted(),
      x,
      y,
    );
    if (elementClickedInside) {
      const elementCenterX =
        elementClickedInside.x + elementClickedInside.width / 2;
      const elementCenterY =
        elementClickedInside.y + elementClickedInside.height / 2;
      const distanceToCenter = Math.hypot(
        x - elementCenterX,
        y - elementCenterY,
      );
      const isSnappedToCenter =
        distanceToCenter < TEXT_TO_CENTER_SNAP_THRESHOLD;
      if (isSnappedToCenter) {
        const { x: wysiwygX, y: wysiwygY } = sceneCoordsToViewportCoords(
          { sceneX: elementCenterX, sceneY: elementCenterY },
          state,
          canvas,
          scale,
        );
        return { wysiwygX, wysiwygY, elementCenterX, elementCenterY };
      }
    }
  }

  private savePointer = (x: number, y: number, button: "up" | "down") => {
    if (!x || !y) {
      return;
    }
    const pointerCoords = viewportCoordsToSceneCoords(
      { clientX: x, clientY: y },
      this.state,
      this.canvas,
      this.props.window.devicePixelRatio,
    );

    if (isNaN(pointerCoords.x) || isNaN(pointerCoords.y)) {
      // sometimes the pointer goes off screen
      return;
    }
    // do not broadcast when more than 1 pointer since that shows flickering on the other side
    gesture.pointers.size < 2 &&
      this.broadcastMouseLocation({
        pointerCoords,
        button,
      });
  };

  private resetShouldCacheIgnoreZoomDebounced = debounce(() => {
    this.setState({ shouldCacheIgnoreZoom: false });
  }, 300);
}

// -----------------------------------------------------------------------------
// TEST HOOKS
// -----------------------------------------------------------------------------

declare global {
  interface Window {
    h: {
      elements: readonly ExcalidrawElement[];
      state: AppState;
      setState: React.Component<any, AppState>["setState"];
      history: SceneHistory;
      app: InstanceType<typeof App>;
    };
  }
}

if (
  process.env.NODE_ENV === ENV.TEST ||
  process.env.NODE_ENV === ENV.DEVELOPMENT
) {
  window.h = {} as Window["h"];

  Object.defineProperties(window.h, {
    elements: {
      get() {
        return globalSceneState.getElementsIncludingDeleted();
      },
      set(elements: ExcalidrawElement[]) {
        return globalSceneState.replaceAllElements(elements);
      },
    },
    history: {
      get: () => history,
    },
  });
}

export default App;
