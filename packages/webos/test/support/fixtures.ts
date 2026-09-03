export const mockClientKey = 'synthetic-mock-client-key';

export const mockUris = {
  systemInfo: 'ssap://system/getSystemInfo',
  softwareInfo: 'ssap://com.webos.service.update/getCurrentSWInformation',
  volume: 'ssap://audio/getVolume',
  apps: 'ssap://com.webos.applicationManager/listLaunchPoints',
  inputs: 'ssap://tv/getExternalInputList',
  network: 'ssap://com.webos.service.connectionmanager/getinfo',
  pointer:
    'ssap://com.webos.service.networkinput/getPointerInputSocket',
} as const;

export const mockResponses = {
  [mockUris.systemInfo]: {
    returnValue: true,
    modelName: '43UP76906LE',
    receiverType: 'DTV',
    productName: 'webOS TV',
  },
  [mockUris.softwareInfo]: {
    returnValue: true,
    product_name: 'webOS',
    model_name: 'HE_DTV_W21O_AFABATAA',
    sdk_version: '6.5.3',
    major_ver: '03',
    minor_ver: '40.85',
  },
  [mockUris.volume]: {
    returnValue: true,
    volume: 17,
    muted: false,
    changed: ['volume', 'muted'],
  },
  [mockUris.apps]: {
    returnValue: true,
    launchPoints: [
      { id: 'com.webos.app.livetv', title: 'TV' },
      { id: 'youtube.leanback.v4', title: 'YouTube' },
    ],
  },
  [mockUris.inputs]: {
    returnValue: true,
    devices: [
      {
        id: 'HDMI_1',
        label: 'HDMI 1',
        connected: true,
        appId: 'com.webos.app.hdmi1',
      },
      {
        id: 'HDMI_2',
        label: 'HDMI 2',
        connected: false,
        appId: 'com.webos.app.hdmi2',
      },
    ],
  },
  [mockUris.network]: {
    returnValue: true,
    wiredInfo: { macAddress: '02:00:00:00:00:01' },
    wifiInfo: { macAddress: '02:00:00:00:00:02' },
  },
} as const;

