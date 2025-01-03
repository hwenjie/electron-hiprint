const Router = require("koa-router");
const address = require("address");
const ipp = require("ipp");
const { machineIdSync } = require("node-machine-id");
const Store = require("electron-store");
const { getPaperSizeInfo, getPaperSizeInfoAll } = require("win32-pdf-printer");
const log = require("./log");
const fs = require('fs')
const path = require('path')
const dayjs = require("dayjs");
const sqlite = require("./aa-sqlite");
const router = new Router();
const { v4 : uuid } = require("uuid");
let ejs = require('ejs');
const templates = require("../template/index");

Store.initRenderer();

const schema = {
    mainTitle: {
        type: "string",
        default: "打印机服务",
    },
    printer: {
        type: "string",
        default: "", // 默认打印机
    },
    openAtLogin: {
        type: "boolean",
        default: true,
    },
    openAsHidden: {
        type: "boolean",
        default: true,
    },
    connectTransit: {
        type: "boolean",
        default: false,
    },
    transitUrl: {
        type: "string",
        default: "",
    },
    transitToken: {
        type: "string",
        default: "",
    },
    allowNotify: {
        type: "boolean",
        default: true,
    },
    closeType: {
        type: "string",
        enum: ["tray", "quit"],
        default: "tray",
    },
    port: {
        type: "number",
        minimum: 10000,
        default: 17521,
    },
    token: {
        type: "string",
        default: "",
    },
    pluginVersion: {
        type: "string",
        default: "",
    },
};

const store = new Store({ schema });

const { app, Notification } = require("electron");

/**
 * @description: 获取当前系统 IP 地址
 * @return {String}
 */
function addressIp() {
    return address.ip();
}

/**
 * @description: 获取当前系统 IPV6 地址
 * @return {String}
 */
function addressIpv6() {
    return address.ipv6();
}

/**
 * @description: 获取当前系统 MAC 地址
 * @return {String}
 */
function addressMac() {
    return new Promise((resolve) => {
        address.mac(function(err, addr) {
            if (err) {
                resolve(err);
            } else {
                resolve(addr);
            }
        });
    });
}

/**
 * @description: 获取当前系统 IP、IPV6、MAC 地址
 * @return {Object}
 */
function addressAll() {
    return new Promise((resolve) => {
        address.mac(function(err, mac) {
            if (err) {
                resolve({ ip: address.ip(), ipv6: address.ipv6(), mac: err });
            } else {
                resolve({ ip: address.ip(), ipv6: address.ipv6(), mac });
            }
        });
    });
}

/**
 * @description: address 方法重写
 * @return {Object}
 */
const _address = {
    ip: addressIp,
    ipv6: addressIpv6,
    mac: addressMac,
    all: addressAll,
};

/**
 * @description: 检查分片任务实例，用于自动删除超时分片信息
 */
const watchTaskInstance = generateWatchTask(
    () => global.PRINT_FRAGMENTS_MAPPING
)();

/**
 * @description: 抛出当前客户端信息，提供更多有价值的信息，逐步替换原有 address
 * @param {io.Socket} socket
 * @return {Void}
 */
function emitClientInfo(socket) {
    _address.mac().then((mac) => {
        socket.emit("clientInfo", {
            version: app.getVersion(), // 版本号
            platform: process.platform, // 平台
            arch: process.arch, // 系统架构
            mac: mac, // mac 地址
            ip: _address.ip(), // ip 地址
            ipv6: _address.ipv6(), // ipv6 地址
            clientUrl: `http://${_address.ip()}:${store.get("port") || 17521}`, // 客户端地址
            machineId: machineIdSync({ original: true }), // 客户端唯一id
        });
    });
}

/**
 * 生成检查分片任务的闭包函数
 * @param {Object} getCheckTarget 获取校验对象，最后会得到global.PRINT_FRAGMENTS_MAPPING
 * @returns {Function}
 */
function generateWatchTask(getCheckTarget) {
    // 记录当前检查任务是否开启，避免重复开启任务
    let isWatching = false;
    /**
     * @description: 检查分片任务实例创建函数
     * @param {Object} config 检查参数，根据实际情况调整
     * @param {number} [config.checkInterval=5] 执行内存检查的时间间隔，单位分钟
     * @param {number} [config.expire=10] 分片信息过期时间，单位分钟，不应过小
     */
    return function generateWatchTaskInstance(config = {}) {
        // 合并用户和默认配置
        const realConfig = Object.assign(
            {
                checkInterval: 5, // 默认检查间隔
                expire: 10, // 默认过期时间
            },
            config
        );
        return {
            startWatch() {
                if (isWatching) return;
                this.createWatchTimeout();
            },
            createWatchTimeout() {
                // 更新开关状态
                isWatching = true;
                return setTimeout(
                    this.clearFragmentsWhichIsExpired.bind(this),
                    realConfig.checkInterval * 60 * 1000
                );
            },
            clearFragmentsWhichIsExpired() {
                const checkTarget = getCheckTarget();
                const currentTimeStamp = Date.now();
                Object.entries(checkTarget).map(([id, fragmentInfo]) => {
                    // 获取任务最后更新时间
                    const { updateTime } = fragmentInfo;
                    // 任务过期时，清除任务信息释放内存
                    if (
                        currentTimeStamp - updateTime >
                        realConfig.expire * 60 * 1000
                    ) {
                        delete checkTarget[id];
                    }
                });
                // 获取剩余任务数量
                const printTaskCount = Object.keys(checkTarget).length;
                // 还有打印任务，继续创建检查任务
                if (printTaskCount) this.createWatchTimeout();
                // 更新开关状态
                else isWatching = false;
            },
        };
    };
}

/**
 * @description: 作为本地服务端时绑定的 socket 事件
 * @param {*} server
 * @return {Void}
 */
function initServeEvent(appServer) {
    // 必须传入实体
    if (!appServer) return false;

    /**
     * @description: 校验 token
     */
    appServer.use(async (ctx, next) => {
        if(ctx.url === '/render'){
            await next();
            return
        };
        
        const token = store.get("token") || "123456";
        const token2 = ctx.headers["authorization"] || "";
        if (token && token !== token2) {
            ctx.body = { status: 401, msg: "token不一致，请检查配置" };
        } else {
            await next();
        }
    });

    /** 获取打印机列表 */
    router.get("/printerList", async (ctx) => {
        ctx.body = {
            status: 200,
            msg: "获取打印机列表成功",
            data: MAIN_WINDOW.webContents.getPrinters() || [],
        };
    });

    /**
     * 获取打印机纸张信息
     * @printer: 打印机名称
     */
    router.get("/getPaperSizeInfo", async (ctx) => {
        if (process.platform === "win32") {
            const { printer } = ctx.query;
            if (!printer) {
                ctx.body = {
                    status: 200,
                    msg: "获取所有打印机纸张信息成功",
                    data: getPaperSizeInfoAll(),
                };
            } else {
                try {
                    ctx.body = {
                        status: 200,
                        msg: `获取打印机-${printer}-纸张信息成功`,
                        data: getPaperSizeInfo({ printer }),
                    };
                } catch (error) {
                    ctx.body = {
                        status: 500,
                        msg: "获取打印机纸张信息失败/不存在",
                    };
                }
            }
        } else {
            ctx.body = {
                status: 500,
                msg: "仅支持windows平台",
            };
        }
    });

    /**
     * 打印
     */
    router.post("/news", async (ctx) => {
        const data = ctx.request.body;
        
        let printer = data.printer || store.get("printer"); // 获取默认打印机，优先接口参数
        if(!printer) {
          ctx.body = {
              status: 500,
              msg: "未选择默认打印机/缺少打印机参数",
          };
          return
        }
        data.printer = printer;

        let _html = data.html || '';
        if(data.templateId){
          let _templateStr = templates[data.templateId];
          
          if(!_templateStr) {
            ctx.body = {
                status: 500,
                msg: "模板不存在",
            };
            return
          } else {
            try{
                _html = ejs.render(_templateStr, data.templateData);
            } catch (error) {
                log(`模板渲染失败: ${error}`);
                ctx.body = {
                    status: 500,
                    msg: "模板渲染失败",
                };
                return
            }
          }
        }

        if (data && _html) {
            data.html = _html;
            const taskId = uuid().replace(/-/g, "");
            const time = dayjs().format("YYYY-MM-DD HH:mm:ss");
            var entry = `'${taskId}','${data.name || ""}','${
                data.templateId
            }','${time}','pending'`;
            var sql =
                "INSERT INTO print_records(task_id, name, templateId, print_time, print_status) VALUES (" +
                entry +
                ")";
            r = await sqlite.run(sql);
            if (r) {
                PRINT_RUNNER.add((done) => {
                    data.taskId = taskId;
                    data.clientType = "local";
                    PRINT_WINDOW.webContents.reload()
                    PRINT_WINDOW.webContents.once('did-finish-load', () => {
                        PRINT_WINDOW.webContents.send("print-new", data);
                        MAIN_WINDOW.webContents.send("printTask", true);
                        PRINT_RUNNER_DONE[data.taskId] = done;
                    });
                });
                ctx.body = {
                    status: 200,
                    data: taskId,
                    msg: "已提交打印",
                };
            }
        } else {
            ctx.body = {
                status: 500,
                msg: "参数错误",
            };
        }
    });

    /**
     * 获取打印结果
     * @taskId: 打印机名称
     */
    router.get("/printInfo", async (ctx) => {
        const { taskId } = ctx.query;
        if (!taskId) {
            ctx.body = {
                status: 500,
                msg: "参数错误",
            };
        } else {
            r = await sqlite.get(
                "SELECT task_id, templateId, print_status,print_time,msg FROM print_records WHERE task_id = ?",
                [taskId]
            );
            if (r) {
                ctx.body = {
                    status: 200,
                    msg: "查询成功",
                    data: r,
                };
            } else {
                ctx.body = {
                    status: 500,
                    msg: "查询结果为空",
                    data: null,
                };
            }
        }
    });

    appServer.use(router.routes());
}

/**
 * @description: 作为客户端连接中转服务时绑定的 socket 事件
 * @return {Void}
 */
function initClientEvent() {
    // 作为客户端连接中转服务时只有一个全局 client
    var client = global.SOCKET_CLIENT;

    /**
     * @description: 连接中转服务成功，绑定 socket 事件
     */
    client.on("connect", () => {
        log(`==> 中转服务 Connected Transit Server: ${client.id}`);
        // 通知渲染进程已连接
        MAIN_WINDOW.webContents.send("clientConnection", true);

        // 判断是否允许通知
        if (store.get("allowNotify")) {
            // 弹出连接成功通知
            const notification = new Notification({
                title: "已连接中转服务器",
                body: `已连接至中转服务器【${store.get(
                    "transitUrl"
                )}】，即刻开印！`,
            });
            // 显示通知
            notification.show();
        }

        // 向 中转服务 发送打印机列表
        client.emit("printerList", MAIN_WINDOW.webContents.getPrinters());

        // 向 中转服务 发送客户端信息
        emitClientInfo(client);
    });

    /**
     * @description: 中转服务 请求客户端信息
     */
    client.on("getClientInfo", () => {
        log(`中转服务 ${client.id}: getClientInfo`);
        emitClientInfo(client);
    });

    /**
     * @description: 中转服务 请求刷新打印机列表
     */
    client.on("refreshPrinterList", () => {
        log(`中转服务 ${client.id}: refreshPrinterList`);
        client.emit("printerList", MAIN_WINDOW.webContents.getPrinters());
    });

    /**
     * @description: 中转服务 调用 ipp 打印 详见：https://www.npmjs.com/package/ipp
     */
    client.on("ippPrint", (options) => {
        log(`中转服务 ${client.id}: ippPrint`);
        try {
            const { url, opt, action, message, replyId } = options;
            let printer = ipp.Printer(url, opt);
            client.emit("ippPrinterConnected", { printer, replyId });
            let msg = Object.assign(
                {
                    "operation-attributes-tag": {
                        "requesting-user-name": "hiPrint",
                    },
                },
                message
            );
            // data 必须是 Buffer 类型
            if (msg.data && !Buffer.isBuffer(msg.data)) {
                if ("string" === typeof msg.data) {
                    msg.data = Buffer.from(msg.data, msg.encoding || "utf8");
                } else {
                    msg.data = Buffer.from(msg.data);
                }
            }
            /**
             * action: Get-Printer-Attributes 获取打印机支持参数
             * action: Print-Job 新建打印任务
             * action: Cancel-Job 取消打印任务
             */
            printer.execute(action, msg, (err, res) => {
                client.emit(
                    "ippPrinterCallback",
                    err
                        ? { type: err.name, msg: err.message, replyId }
                        : { replyId },
                    res
                );
            });
        } catch (error) {
            log(`中转服务 ${client.id}: ippPrint error: ${error.message}`);
            client.emit("ippPrinterCallback", {
                type: error.name,
                msg: error.message,
                replyId,
            });
        }
    });

    /**
     * @description: 中转服务 ipp request 详见：https://www.npmjs.com/package/ipp
     */
    client.on("ippRequest", (options) => {
        log(`中转服务 ${client.id}: ippRequest`);
        try {
            const { url, data, replyId } = options;
            let _data = ipp.serialize(data);
            ipp.request(url, _data, (err, res) => {
                client.emit(
                    "ippRequestCallback",
                    err
                        ? { type: err.name, msg: err.message, replyId }
                        : { replyId },
                    res
                );
            });
        } catch (error) {
            log(`中转服务 ${client.id}: ippRequest error: ${error.message}`);
            client.emit("ippRequestCallback", {
                type: error.name,
                msg: error.message,
                replyId,
            });
        }
    });

    /**
     * @description: 中转服务 常规打印任务
     */
    client.on("news", (data) => {
        if (data) {
            PRINT_RUNNER.add((done) => {
                data.socketId = client.id;
                data.taskId = new Date().getTime();
                data.clientType = "transit";
                PRINT_WINDOW.webContents.send("print-new", data);
                MAIN_WINDOW.webContents.send("printTask", true);
                PRINT_RUNNER_DONE[data.taskId] = done;
            });
        }
    });

    /**
     * @description: 中转服务 断开连接
     */
    client.on("disconnect", () => {
        log(`==> 中转服务 Disconnect: ${client.id}`);
        MAIN_WINDOW.webContents.send("clientConnection", false);
    });
}

module.exports = {
    store,
    address: _address,
    initServeEvent,
    initClientEvent,
};
