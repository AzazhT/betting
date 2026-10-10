let selectedLeague = "all";

  function changeFilter(filter, button) {
    currentFilter = filter;
    selectedLeague = "all"; // ሊግ ሲቀየር የሊግ ማጣሪያውን ዳግም ያስጀምራል
    document.querySelectorAll(".nav button").forEach(btn => btn.classList.remove("active"));
    button.classList.add("active");
    renderEvents();
  }

  function filterByLeague(leagueName) {
    selectedLeague = leagueName;
    renderEvents();
  }

  function getFilteredEvents() {
    const search = document.getElementById("search").value.toLowerCase().trim();

    return events.filter(event => {
      const text = (
        (event.home?.name || "") + " " +
        (event.away?.name || "") + " " +
        (event.league || "")
      ).toLowerCase();

      if (search && !text.includes(search)) return false;

      // Leagues tab filter
      if (currentFilter === "leagues" && selectedLeague !== "all") {
        if (event.league !== selectedLeague) return false;
      }

      if (currentFilter === "live") {
        return event.live === true;
      }

      if (currentFilter === "today") {
        if (!event.startTime) return false;
        const now = new Date();
        const date = new Date(event.startTime);
        return date.toDateString() === now.toDateString();
      }

      if (currentFilter === "tomorrow") {
        if (!event.startTime) return false;
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const date = new Date(event.startTime);
        return date.toDateString() === tomorrow.toDateString();
      }

      return true;
    });
  }

  function renderEvents() {
    const container = document.getElementById("events");

    // "Leagues" tab ተመርጦ ሳለ የትኛውንም ሊግ ካልመረጠ የሊጎቹን ዝርዝር (Menu) ያሳያል
    if (currentFilter === "leagues" && selectedLeague === "all") {
      const uniqueLeagues = [...new Set(events.map(e => e.league || "Football"))];
      
      container.innerHTML = `
        <div style="padding: 10px;">
          <h3 style="margin-bottom: 12px; font-size: 18px; color: #a9b9ca;">Select a League</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px;">
            ${uniqueLeagues.map(league => `
              <button onclick="filterByLeague('${escapeJs(league)}')" style="background: #13263d; border: 1px solid #29415d; color: #fff; padding: 12px; border-radius: 8px; cursor: pointer; text-align: left; font-weight: 700;">
                🏆 ${escapeHtml(league)}
              </button>
            `).join("")}
          </div>
        </div>
      `;
      return;
    }

    const filtered = getFilteredEvents();

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="loading">
          No football matches found.
          ${currentFilter === 'leagues' ? '<br><br><button class="refresh" onclick="selectedLeague=\'all\'; renderEvents();">← Back to Leagues</button>' : ''}
        </div>
      `;
      return;
    }

    let headerHtml = "";
    if (currentFilter === "leagues") {
      headerHtml = `
        <div style="margin-bottom: 10px;">
          <button class="refresh" onclick="selectedLeague='all'; renderEvents();">← Back to Leagues</button>
        </div>
      `;
    }

    container.innerHTML = headerHtml + filtered.map(event => eventCard(event)).join("");
  }
