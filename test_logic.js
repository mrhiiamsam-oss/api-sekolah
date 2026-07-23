
const diffData = [
  { nama: "Prov 1", total_api: 60000, selisih: 10, isSyncedToday: false },
  { nama: "Prov 2", total_api: 50000, selisih: 10, isSyncedToday: false },
  { nama: "Prov 3", total_api: 20000, selisih: 10, isSyncedToday: false },
  { nama: "Prov 4", total_api: 30000, selisih: 10, isSyncedToday: false },
  { nama: "Prov 5", total_api: 40000, selisih: 10, isSyncedToday: false },
  { nama: "Prov 6", total_api: 15000, selisih: 10, isSyncedToday: false }
];

let BATAS_AMAN = 100000;
let SISA_KUOTA = 100000; // Hari ini masih utuh

let currentSimulatedDayOffset = 0;
let currentSimulatedQuota = SISA_KUOTA;
let currentSimulatedRunning = 0;
let isFirstOfSimulatedDay = true;
let queueCounters = {};

let results = diffData.map(d => {
    let dayAssigned = currentSimulatedDayOffset;
    
    if (currentSimulatedRunning + d.total_api <= currentSimulatedQuota || isFirstOfSimulatedDay) {
        // Fits in current day
        currentSimulatedRunning += d.total_api;
        isFirstOfSimulatedDay = false;
    } else {
        // Move to next day
        currentSimulatedDayOffset++;
        dayAssigned = currentSimulatedDayOffset;
        currentSimulatedQuota = 100000; // future day quota (assuming Smart Sync day)
        currentSimulatedRunning = d.total_api;
        isFirstOfSimulatedDay = false;
    }
    
    queueCounters[dayAssigned] = (queueCounters[dayAssigned] || 0) + 1;
    return {
        nama: d.nama,
        dayOffset: dayAssigned,
        queueNum: queueCounters[dayAssigned]
    };
});
console.log(results);
