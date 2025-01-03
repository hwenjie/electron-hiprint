# electron-hiprint
electron开发的打印软件，电脑客户端软件（需要安装在电脑上的服务软件）

由[electron-hiprint](https://gitee.com/CcSimple/electron-hiprint)魔改而来，改动如下：

1、由websocket改为http api调用打印，更方便调用

2、使用[bookjs-eazy](https://gitee.com/wuxue107/bookjs-eazy)控制打印格式，完美支持各种换行、分页等问题

3、添加模板支持，使用ejs渲染。准备好模板和数据，直接打印

4、本地添加sqlite，记录打印结果

5、仅支持本地局域网打印。服务端中转服务不可用



## api

> 需要header中添加Authorization，值和客户端中设置的一样,默认123456
>
> 接口地址为，客户端中的地址+以下文档路径

### 1、获取打印机列表

```
/printerList get
```

### 2、获取打印机纸张信息

```
获取所有纸张信息
/getPaperSizeInfo get
获取指定打印机纸张信息
/getPaperSizeInfo?printer=打印机名称 get
```

### 3、打印

```
/news post

post参数
1、模板打印参数
{"templateId":"测试打印单", "templateData": { "name": "你好，打印" }}
2、直接打印html
{ "html": "" }
3、指定打印机
{ "printer"： ""} // 打印机名称，不使用客户端默认指定的打印机
```

### 4、查看打印结果

```
/printInfo?taskId=taskId get
```

## 模板&&设计

> template目录下测试打印单-设计器，直接在浏览器中打开查看打印效果，每个模板对应一个设计器
>
> 其他模板自行添加，并加入到index.js中
>
> 打印时templateId传模板文件名，templateData是需要渲染打印的数据
