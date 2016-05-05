"use strict";

global._ = require('./modules/utils/underscore');

const fs = require('fs');
const electron = require('electron');
const app = require('app');  // Module to control application life.
const timesync = require("os-timesync");
const BrowserWindow = require('browser-window');  // Module to create native browser window.
const Minimongo = require('./modules/minimongoDb.js');
const syncMinimongo = require('./modules/syncMinimongo.js');
const ipc = electron.ipcMain;
const dialog = require('dialog');
const packageJson = require('./package.json');
const i18n = require('./modules/i18n.js');
const logger = require('./modules/utils/logger');
const Sockets = require('./modules/sockets');

// CLI options
const argv = require('yargs')
    .usage('Usage: $0 [options]')
    .describe('version', 'Display app version')
    .describe('mode', 'App mode: wallet, mist (default)')
    .describe('gethpath', 'Path to geth executable to use instead of default')
    .describe('ethpath', 'Path to eth executable to use instead of default')
    .describe('ignore-gpu-blacklist', 'Ignores GPU blacklist (needed for some Linux installations)')
    .describe('logfile', 'Logs will be written to this file')
    .describe('loglevel', 'Minimum logging threshold: trace (all logs), debug, info (default), warn, error')
    .alias('m', 'mode')
    .help('h')
    .alias('h', 'help')
    .parse(process.argv.slice(1));

if (argv.version) {
    console.log(packageJson.version);
    process.exit(0);
}

if (argv.ignoreGpuBlacklist) {
    app.commandLine.appendSwitch('ignore-gpu-blacklist', 'true');
}

// logging setup
logger.setup(argv);
const log = logger.create('main');

// GLOBAL Variables
global.path = {
    HOME: app.getPath('home'),
    APPDATA: app.getPath('appData'), // Application Support/
    USERDATA: app.getPath('userData') // Application Aupport/Mist
};

global.appName = 'Mist';

global.production = false;

global.mode = (argv.mode ? argv.mode : 'mist');
global.paths = {
    geth: argv.gethpath,
    eth: argv.ethpath,
};

global.version = packageJson.version;
global.license = packageJson.license;


require('./modules/ipcCommunicator.js');
const appMenu = require('./modules/menuItems');
const ipcProviderBackend = require('./modules/ipc/ipcProviderBackend.js');
const NodeConnector = require('./modules/ipc/nodeConnector.js');
const popupWindow = require('./modules/popupWindow.js');
const ethereumNode = require('./modules/ethereumNode.js');
const getIpcPath = require('./modules/ipc/getIpcPath.js');
var ipcPath = getIpcPath();

global.mainWindow = null;
global.windows = {};
global.webviews = [];

global.mining = false;

global.icon = __dirname +'/icons/'+ global.mode +'/icon.png';

global.language = 'en';
global.i18n = i18n; // TODO: detect language switches somehow

global.Tabs = Minimongo('tabs');
global.nodeConnector = new NodeConnector(ipcPath);


// INTERFACE PATHS
global.interfaceAppUrl;
global.interfacePopupsUrl;

// WALLET
if(global.mode === 'wallet') {
    log.info('Starting in Wallet mode');

    global.interfaceAppUrl = (global.production)
        ? 'file://' + __dirname + '/interface/wallet/index.html'
        : 'http://localhost:3050';
    global.interfacePopupsUrl = (global.production)
        ? 'file://' + __dirname + '/interface/index.html'
        : 'http://localhost:3000';

// MIST
} else {
    log.info('Starting in Mist mode');

    global.interfaceAppUrl = global.interfacePopupsUrl = (global.production)
        ? 'file://' + __dirname + '/interface/index.html'
        : 'http://localhost:3000';
}


// prevent crashed and close gracefully
process.on('uncaughtException', function(error){
    log.error('UNCAUGHT EXCEPTION', error);

    app.quit();
});



// Quit when all windows are closed.
app.on('window-all-closed', function() {
    // if (process.platform != 'darwin')
    app.quit();
});

// Listen to custom protocole incoming messages, needs registering of URL schemes
app.on('open-url', function (e, url) {
    log.info('Open URL', url);
});


var killedSockets = false;

app.on('before-quit', function(event){
    if(!killedSockets) {
        event.preventDefault();
    }

    // sockets manager
    Sockets.destroyAll()
        .catch((err) => {
            log.error('Error shutting down sockets');
        });

    // CLEAR open IPC sockets to geth
    _.each(global.sockets || {}, function(socket){
        if (socket) {
            log.info('Closing socket', socket.id);
            socket.destroy();
        }
    });

    // delay quit, so the sockets can close
    setTimeout(function(){
        killedSockets = true;

        ethereumNode.stop().then(function() {
            app.quit(); 
        });
    }, 500);
});



var appStartWindow;

const NODE_TYPE = 'geth';
const NODE_LOGGER = logger.create('eth-node');

const logFunction = function(data) {
    data = data.toString().replace(/[\r\n]+/,'');

    NODE_LOGGER.trace(data);

    // show line if its not empty or "------"
    if(appStartWindow && !/^\-*$/.test(data) && !_.isEmpty(data)) {
        appStartWindow.webContents.send('startScreenText', 'logText', data.replace(/^.*[0-9]\]/,''));
    }
};

// This method will be called when Electron has done everything
// initialization and ready for creating browser windows.
app.on('ready', function() {

    // init prepared popup window
    popupWindow.loadingWindow.init();

    // initialize the IPC provider on the main window
    ipcProviderBackend();

    // instantiate custom protocols
    require('./customProtocols.js');

    // add menu already here, so we have copy and past functionality
    appMenu();


    // Create the browser window.

    // MIST
    if(global.mode === 'mist') {
        global.mainWindow = new BrowserWindow({
            title: global.appName,
            show: false,
            width: 1024 + 208,
            height: 720,
            icon: global.icon,
            titleBarStyle: 'hidden-inset', //hidden-inset: more space
            backgroundColor: '#D2D2D2',
            acceptFirstMouse: true,
            darkTheme: true,
            webPreferences: {
                preload: __dirname +'/modules/preloader/mistUI.js',
                nodeIntegration: false,
                'overlay-scrollbars': true,
                webaudio: true,
                webgl: false,
                textAreasAreResizable: true,
                webSecurity: false // necessary to make routing work on file:// protocol
            }
        });

        syncMinimongo(Tabs, global.mainWindow.webContents);


    // WALLET
    } else {

        global.mainWindow = new BrowserWindow({
            title: global.appName,
            show: false,
            width: 1100,
            height: 720,
            icon: global.icon,
            titleBarStyle: 'hidden-inset', //hidden-inset: more space
            backgroundColor: '#F6F6F6',
            acceptFirstMouse: true,
            darkTheme: true,
            webPreferences: {
                preload: __dirname +'/modules/preloader/wallet.js',
                nodeIntegration: false,
                'overlay-fullscreen-video': true,
                'overlay-scrollbars': true,
                webaudio: true,
                webgl: false,
                textAreasAreResizable: true,
                webSecurity: false // necessary to make routing work on file:// protocol
            }
        });
    }

    appStartWindow = new BrowserWindow({
            title: global.appName,
            width: 400,
            height: 230,
            icon: global.icon,
            resizable: false,
            backgroundColor: '#F6F6F6',
            useContentSize: true,
            frame: false,
            webPreferences: {
                preload: __dirname +'/modules/preloader/splashScreen.js',
                nodeIntegration: false,
                webSecurity: false // necessary to make routing work on file:// protocol
            }
        });
    appStartWindow.loadURL(global.interfacePopupsUrl + '#splashScreen_'+ global.mode);//'file://' + __dirname + '/interface/startScreen/'+ global.mode +'.html');


    // check time sync
    // var ntpClient = require('ntp-client');
    // ntpClient.getNetworkTime("pool.ntp.org", 123, function(err, date) {
    timesync.checkEnabled(function (err, enabled) {
        if(err) {
            log.error('Couldn\'t get time from NTP time sync server.', err);
            return;
        }

        if(!enabled) {
            dialog.showMessageBox({
                type: "warning",
                buttons: ['OK'],
                message: global.i18n.t('mist.errors.timeSync.title'),
                detail: global.i18n.t('mist.errors.timeSync.description') +"\n\n"+ global.i18n.t('mist.errors.timeSync.'+ process.platform)
            }, function(){
            });
        }
    });



    appStartWindow.webContents.on('did-finish-load', function() {
        // START GETH
        const checkNodeSync = require('./modules/checkNodeSync.js');
        const socket = Sockets.get('node-ipc');

        socket.connect({ path: ipcPath })
            .catch((err) => {
                log.warn('Failed to connect to geth. Maybe it\'s not running so let\'s start our own...');

                if (appStartWindow) {
                    log.debug('Tell UI we are going to start a node');
                    appStartWindow.webContents.send('startScreenText', 'mist.startScreen.startingNode');
                }

                log.info(`Node type: ${ethereumNode.defaultNodeType}`);
                log.info(`Network: ${ethereumNode.defaultNetwork}`);

                return ethereumNode.start()
                    .catch((err) => {
                        log.error('Failed to start node', err);

                        if (appStartWindow) {
                            appStartWindow.webContents.send('startScreenText', 'mist.startScreen.nodeBinaryNotFound');
                        }
                            
                        throw err;
                    })
                    .then(() => {
                        return socket.connect({ path: ipcPath }, {
                            timeout: 120000 /* 2 minutes */
                        })
                            .catch((err) => {
                                log.error('Failed to connect to node', err);

                                if (appStartWindow) {
                                    appStartWindow.webContents.send('startScreenText', 'mist.startScreen.nodeConnectionTimeout', ipcPath);
                                }

                                throw err;
                            });
                    })
                    .catch((err) => {
                        let log = ethereumNode.getNodeLog();

                        if (log) {
                            log = '...'+ log.slice(-1000);
                        } else {
                            log = global.i18n.t('mist.errors.nodeStartup');
                        }

                        // add node type
                        log = 'Node type: '+ NODE_TYPE + "\n" +
                            'Network: '+ ethereumNode.defaultNetwork + "\n" +
                            'Platform: '+ process.platform +' (Architecure '+ process.arch +')'+"\n\n" +
                            log;

                        dialog.showMessageBox({
                            type: "error",
                            buttons: ['OK'],
                            message: global.i18n.t('mist.errors.nodeConnect'),
                            detail: log
                        }, function(){});
                    });
            })
            .then(() => {
                if (!socket.isConnected) {
                    log.info('Either geth didn\'t start or IPC socket failed to connect.');

                    return app.quit();
                }

                /* At this point Geth is running and the socket is connected. */

                log.info('Connected via IPC to geth.');

                if (ethereumNode.isRunning) {
                    ethereumNode.on('data', logFunction);

                    appStartWindow.webContents.send('startScreenText', 'mist.startScreen.startedNode');
                } else {
                    appStartWindow.webContents.send('startScreenText', 'mist.startScreen.runningNodeFound');
                }

                // update menu, to show node switching possibilities
                appMenu();

                // TRY TO CONNECT EVERY 500MS
                // if(!e) {
                //     intervalId = setInterval(function(){
                //         if(socket)
                //             socket.connect({path: ipcPath});
                //     }, 200);

                checkNodeSync(
                    appStartWindow,
                    // -> callback splash screen finished
                    function(e) {
                        if(appStartWindow) {
                            appStartWindow.webContents.send('startScreenText', 'mist.startScreen.startedNode');
                        }

                        socket.destroy();

                        startMainWindow(appStartWindow);

                    // -> callback onboarding
                    }, 
                    function(){
                        if(appStartWindow) {
                            appStartWindow.close();
                        }
                        appStartWindow = null;

                        var onboardingWindow = popupWindow.show('onboardingScreen', {width: 576, height: 442});
                        // onboardingWindow.openDevTools();
                        onboardingWindow.on('close', function(){
                            app.quit();
                        });

                        // change network types (mainnet, testnet)
                        ipc.on('onBoarding_changeNet', function(e, testnet) {
                            let newType = ethereumNode.type;
                            let newNetwork = testnet ? 'test' : 'main';

                            ethereumNode.stop()
                                .then(() => {
                                    return ethereumNode.start(newType, newNetwork)
                                        .then(() => {
                                            log.info('Changed node', newType, newNetwork);

                                            appMenu();
                                        });
                                })
                                .catch((err) => {
                                    log.error('Error changing network', err);
                                });
                        });

                        // launch app
                        ipc.on('onBoarding_launchApp', function(e) {
                            socket.destroy();

                            // prevent that it closes the app
                            onboardingWindow.removeAllListeners('close');
                            onboardingWindow.close();
                            onboardingWindow = null;

                            popupWindow.loadingWindow.show();

                            ipc.removeAllListeners('onBoarding_changeNet');
                            ipc.removeAllListeners('onBoarding_launchApp');

                            startMainWindow(appStartWindow);
                        });
                    }
                );
            }); /* socket connected successfully to geth */;

    }); /* on appStartWindow did-finish-load */

}); /* on app ready */




/**
Start the main window and all its processes

@method startMainWindow
*/
var startMainWindow = function(appStartWindow){
    // remove the splash screen logger
    ethereumNode.removeListener('data', logFunction);

    // and load the index.html of the app.
    log.info('Loading Interface at '+ global.interfaceAppUrl);
    global.mainWindow.loadURL(global.interfaceAppUrl);

    global.mainWindow.webContents.on('did-finish-load', function() {
        popupWindow.loadingWindow.hide();

        global.mainWindow.show();
        // global.mainWindow.center();

        if(appStartWindow) {
            appStartWindow.close();
        }
        appStartWindow = null;
    });

    // close app, when the main window is closed
    global.mainWindow.on('closed', function() {
        global.mainWindow = null;

        app.quit();
    });


    // STARTUP PROCESSES


    // instantiate the application menu
    Tracker.autorun(function(){
        global.webviews = Tabs.find({},{sort: {position: 1}, fields: {name: 1, _id: 1}}).fetch();
        appMenu(global.webviews);
    });
};