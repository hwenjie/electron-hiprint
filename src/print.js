"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const printPdf = require("./pdf-print");
const log = require("../tools/log");
const sqlite = require("../tools/aa-sqlite")

/**
 * @description: 创建打印窗口
 * @return {BrowserWindow} PRINT_WINDOW 打印窗口
 */
async function createPrintWindow() {
  const windowOptions = {
    width: 1000, // 窗口宽度
    height: 1000, // 窗口高度
    show: false, // 不显示
    webPreferences: {
      contextIsolation: false, // 设置此项为false后，才可在渲染进程中使用electron api
      nodeIntegration: true,
    },
  };

  // 创建打印窗口
  PRINT_WINDOW = new BrowserWindow(windowOptions);

  // 加载打印渲染进程页面
  let printHtml = path.join("file://", app.getAppPath(), "/assets/print.html");
  PRINT_WINDOW.webContents.loadURL(printHtml);

  // 未打包时打开开发者工具
  // if (!app.isPackaged) {
  //   PRINT_WINDOW.webContents.openDevTools();
  // }

  // 绑定窗口事件
  initPrintEvent();

  return PRINT_WINDOW;
}

/**
 * @description: 绑定打印窗口事件
 * @return {Void}
 */
function initPrintEvent() {
  ipcMain.on("do", async(event, data) => {
    const printers = PRINT_WINDOW.webContents.getPrinters();
    let havePrinter = false;
    let defaultPrinter = "";
    let printerError = false;
    printers.forEach((element) => {
      // 判断打印机是否存在
      if (element.name === data.printer) {
        // todo: 打印机状态对照表
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // cups: https://www.cups.org/doc/cupspm.html#ipp_status_e
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
      // 获取默认打印机
      if (element.isDefault) {
        defaultPrinter = element.name;
      }
    });
    if (printerError) {
      let _error_info = `${data.replyId?'中转服务':'插件端'} ${ data.taskId } 模板 【${data.templateId}】 打印失败，打印机异常，打印机：${data.printer}`;
      log(_error_info);

      var sql = `
        UPDATE print_records
        SET print_status = ?, msg = ?
        WHERE task_id = ?
      `
      try{
        r = await sqlite.run2(sql, ['failed', _error_info, data.taskId]);
        if(r) {
          console.log("print_records updated")
        }
      }catch(e){
        console.log(e);
      }
      
      // 通过 taskMap 调用 task done 回调
      PRINT_RUNNER_DONE[data.taskId]();
      delete PRINT_RUNNER_DONE[data.taskId];
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    let deviceName = havePrinter ? data.printer : defaultPrinter;

    // 打印 详见https://www.electronjs.org/zh/docs/latest/api/web-contents
    PRINT_WINDOW.webContents.print(
      {
        silent: data.silent ?? true, // 静默打印
        printBackground: data.printBackground ?? true, // 是否打印背景
        deviceName: deviceName, // 打印机名称
        color: data.color ?? true, // 是否打印颜色
        margins: data.margins ?? {
          marginType: "none",
        }, // 边距
        landscape: data.landscape ?? false, // 是否横向打印
        scaleFactor: data.scaleFactor ?? 100, // 打印缩放比例
        pagesPerSheet: data.pagesPerSheet ?? 1, // 每张纸的页数
        collate: data.collate ?? true, // 是否排序
        copies: data.copies ?? 1, // 打印份数
        pageRanges: data.pageRanges ?? {}, // 打印页数
        duplexMode: data.duplexMode, // 打印模式 simplex,shortEdge,longEdge
        dpi: data.dpi, // 打印机DPI
        header: data.header, // 打印头
        footer: data.footer, // 打印尾
        pageSize: data.pageSize, // 打印纸张
      },
      async(success, failureReason) => {
        let _info = "";
        if (success) {
          _info = `成功-页数：${data.pageNum},打印机：${deviceName}`
        } else {
          _info = `失败-原因：${failureReason},打印机：${deviceName}`
        }

        var sql = `
          UPDATE print_records
          SET print_status = ?, msg = ?
          WHERE task_id = ?
        `
        r = await sqlite.run2(sql, [success?'completed':'failed', _info, data.taskId]);
        if(r) {
          console.log("print_records updated")
        }

        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        // 删除 task
        delete PRINT_RUNNER_DONE[data.taskId];
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      }
    );
  });
}

module.exports = async () => {
  // 创建打印窗口
  await createPrintWindow();
};
