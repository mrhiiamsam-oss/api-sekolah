
const diffData = [
  { nama: "JATIM", total_api: 91000 },
  { nama: "SULTRA", total_api: 7000 },
  { nama: "BALI", total_api: 6000 }
];

let SISA_KUOTA = 25000;
let BATAS_AMAN = 277000;
let syncedToday = 251000;

// Simulate days
let days = [
  { offset: 0, used: syncedToday, limit: BATAS_AMAN, items: 0 }
];

diffData.forEach((d) => {
    let assigned = false;
    for (let i = 0; i < days.length; i++) {
        let day = days[i];
        if (day.used + d.total_api <= day.limit) {
            day.used += d.total_api;
            day.items++;
            d.assignedDayOffset = day.offset;
            assigned = true;
            break;
        } else if (day.items === 0 && day.used === 0) {
            // Force if day is completely empty to prevent deadlock
            day.used += d.total_api;
            day.items++;
            d.assignedDayOffset = day.offset;
            assigned = true;
            break;
        }
    }
    if (!assigned) {
        // Create new day
        let newOffset = days[days.length - 1].offset + 1;
        let newLimit = 100000; // Simplified for test
        let newDay = { offset: newOffset, used: d.total_api, limit: newLimit, items: 1 };
        days.push(newDay);
        d.assignedDayOffset = newOffset;
    }
});

console.log(diffData.map(d => `${d.nama}: Day ${d.assignedDayOffset}`));
