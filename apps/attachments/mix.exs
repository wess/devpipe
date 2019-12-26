#
#  mix.exs
#  attachments
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Attachments.MixProject do
  use Mix.Project

  def project do
    [
      app:              :attachments,
      version:          "0.0.1",
      build_path:       "../../_build",
      config_path:      "../../config/config.exs",
      deps_path:        "../../deps",
      lockfile:         "../../mix.lock",
      elixir:           "~> 1.9",
      start_permanent:  Mix.env() == :prod,
      deps:             deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:data, in_umbrella: true},
      {:ext,  in_umbrella: true},
      {:waffle,       "~> 0.0.3"},
      {:waffle_ecto,  "~> 0.0.3"},
      {:zarex,        "~> 1.0"},
    ]
  end
end
