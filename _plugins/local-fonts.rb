# Keep the Chirpy typefaces, but serve them from this site so they are available
# with the first render instead of replacing fallback fonts after page load.
Jekyll::Hooks.register :site, :post_read do |site|
  cors = site.data.dig('origin', 'cors')
  next unless cors

  cors['webfonts'] = '/assets/fonts/fonts.css'
  cors['resource_hints'] = cors.fetch('resource_hints', []).reject do |hint|
    hint.fetch('url', '').start_with?('https://fonts.')
  end
end
