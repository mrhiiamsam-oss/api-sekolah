
const diffData = [
  { nama: "BALI", total_api: 6000, isSyncedToday: true },
  { nama: "JATIM", total_api: 91000, isSyncedToday: false },
  { nama: "SULTRA", total_api: 7000, isSyncedToday: false }
];

let SISA_KUOTA = 25000;
let BATAS_AMAN = 277000;
let syncedToday = 251000;

let daysSim = [{ offset: 0, used: syncedToday, limit: BATAS_AMAN, items: 0 }];
let queueCounters = {};

let results = diffData.map((d, i) => {
    let assignedDayOffset = -1;
    let assigned = false;
    
    // Determine the minimum offset this item can be placed in
    let minOffset = d.isSyncedToday ? 1 : 0;
    
    for (let j = 0; j < daysSim.length; j++) {
        let day = daysSim[j];
        if (day.offset < minOffset) continue; // Skip days before the minimum allowed offset
        
        if (day.used + d.total_api <= day.limit) {
            day.used += d.total_api;
            day.items++;
            assignedDayOffset = day.offset;
            assigned = true;
            break;
        } else if (day.items === 0 && day.used === 0) {
            day.used += d.total_api;
            day.items++;
            assignedDayOffset = day.offset;
            assigned = true;
            break;
        }
    }
    
    if (!assigned) {
        let newOffset = Math.max(minOffset, daysSim[daysSim.length - 1].offset + 1);
        let newLimit = 100000; // Mock limit
        
        // If we are jumping offsets (e.g. from day 0 to day 1 directly), we might need to insert the day
        let newDay = { offset: newOffset, used: d.total_api, limit: newLimit, items: 1 };
        daysSim.push(newDay);
        // Ensure daysSim is sorted by offset, though push usually keeps it sorted if we just increment
        daysSim.sort((a,b) => a.offset - b.offset);
        assignedDayOffset = newOffset;
    }
    
    queueCounters[assignedDayOffset] = (queueCounters[assignedDayOffset] || 0) + 1;
    
    return {
        nama: d.nama,
        dayOffset: assignedDayOffset,
        queueNum: queueCounters[assignedDayOffset]
    };
});

console.log(results);
